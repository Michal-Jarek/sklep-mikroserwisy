import json
import logging
import time
from datetime import timedelta
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import update

from app import store
from app.database import utcnow
from app.events import handle, parse_envelope
from app.models import Order
from tests.conftest import orders_in_db, outbox


def create(client, headers, body, status=201):
    response = client.post("/orders", headers=headers, json=body)
    assert response.status_code == status, response.text
    return response.json()


def test_checkout_and_payment(client, deps, headers, body):
    order = create(client, headers, body)
    assert create(client, headers, body) == order and len(deps.calls) == 5
    assert order["total"] == "54.97" and order["itemsTotal"] == "39.98" and order["status"] == "PAID"
    assert client.get("/orders", headers=headers).json()["items"][0]["itemCount"] == 1
    assert [e["type"] for e in outbox(client)] == ["order.created"]
    result = client.get("/orders/purchased", headers={"X-User-Roles": "SERVICE"},
                        params={"userId": headers["X-User-Id"], "productId": deps.product})
    assert result.json() == {"purchased": True}
    # D11: every call carries the client's id, its roles + SERVICE and the request id.
    assert all(set(c.headers["X-User-Roles"].split(",")) == {"CUSTOMER", "SERVICE"} for c in deps.calls)
    assert all(c.headers["X-User-Id"] == headers["X-User-Id"] and c.headers["X-Request-Id"] for c in deps.calls)
    assert json.loads(deps.made("inventory", "POST")[0].content)["items"] == [{"productId": deps.product,
                                                                                "quantity": 2}]


def test_failed_payment(client, deps, headers, body):
    body["payment"]["cardNumber"] = "4111111111111110"
    response = client.post("/orders", headers={k: v for k, v in headers.items() if k != "Idempotency-Key"}, json=body)
    assert response.status_code == 201 and response.json()["status"] == "PAYMENT_FAILED"
    assert deps.calls[-1].method == "DELETE" and deps.calls[-1].url.path.startswith("/inventory/reservations/")
    assert not outbox(client) and not deps.made("cart", "DELETE")
    assert "4111111111111110" not in response.text


def test_failed_payment_waits_for_release(client, deps, headers, body):
    """PAYMENT_FAILED only after the reservation is released; otherwise NEW stays and the same key finishes."""
    body["payment"]["cardNumber"] = "4111111111111110"
    deps.rules["inventory:DELETE"] = {"status": 503}
    response = client.post("/orders", headers=headers, json=body)
    assert response.status_code == 503 and "tym samym kluczem" in response.json()["message"]
    assert [o.status for o in orders_in_db(client)] == ["NEW"]
    deps.rules.clear()
    assert create(client, headers, body)["status"] == "PAYMENT_FAILED"
    assert len(orders_in_db(client)) == 1


def test_cancel_by_admin(client, deps, headers, body):
    path = "/orders/" + create(client, headers, body)["id"]
    admin = {**headers, "X-User-Id": str(uuid4()), "X-User-Roles": "ADMIN"}
    assert client.post(path + "/cancel", headers=admin).json()["status"] == "CANCELLED"
    assert client.post(path + "/cancel", headers=admin).json()["error"] == "ORDER_NOT_CANCELLABLE"
    assert [e["type"] for e in outbox(client)] == ["order.created", "order.cancelled"]


def shipment_event(order_id, user_id, status):
    return json.dumps(dict(type="shipment.status_changed", eventId=str(uuid4()), version=1,
                           occurredAt="2026-11-14T10:00:00.000Z", requestId="test",
                           payload=dict(orderId=order_id, userId=user_id, newStatus=status))).encode()


def test_shipping_is_monotonic(client, headers, body):
    oid = create(client, headers, body)["id"]
    for status in ["SHIPPED", "IN_TRANSIT", "PREPARING"]:
        raw = shipment_event(oid, headers["X-User-Id"], status)
        for _ in range(2):
            handle(client.app.state.session_factory, parse_envelope(raw, "shipment.status_changed"))
    assert client.get("/orders/" + oid, headers=headers).json()["status"] == "SHIPPED"
    assert client.post(f"/orders/{oid}/cancel", headers=headers).status_code == 409


def test_auth_and_health(client, headers):
    assert client.get("/health/ready").status_code == 200
    assert client.get("/health/live").json() == {"status": "UP"}
    assert client.get("/orders").status_code == 401
    assert client.get("/orders/purchased", headers=headers).status_code == 403
    assert client.get("/orders/bad", headers=headers).json()["error"] == "VALIDATION_ERROR"
    head = client.head("/orders", headers=headers)
    assert head.status_code == 200 and head.content == b""
    assert client.head("/health/live").status_code == 200


@pytest.mark.parametrize("first_status", [503, 409])
def test_reservation_failure(client, deps, headers, body, first_status):
    deps.rules["inventory:POST"] = {"status": first_status}
    response = client.post("/orders", headers=headers, json=body)
    assert response.status_code == first_status
    assert not orders_in_db(client)
    # 503: the reservation may exist (compensation releases it); 409: nothing was reserved.
    assert len(deps.made("inventory", "DELETE")) == (1 if first_status == 503 else 0)
    if first_status == 503:
        deps.rules.clear()
        retry = create(client, headers, body)
        assert retry["status"] == "PAID"
        assert json.loads(deps.made("inventory", "POST")[-1].content)["orderId"] == retry["id"]
    else:
        assert response.json()["error"] == "INSUFFICIENT_STOCK"
        assert client.post("/orders", headers=headers, json=body).status_code == 409
        assert not outbox(client)


def test_reused_key_and_invalid_event(client, headers, body):
    create(client, headers, body)
    changed = {**body, "shippingAddress": {**body["shippingAddress"], "city": "Łódź"}}
    conflict = client.post("/orders", headers=headers, json=changed)
    assert conflict.status_code == 409 and conflict.json()["error"] == "CONFLICT"
    other_method = client.post("/orders", headers=headers, json={**body, "shippingMethod": "PICKUP"})
    assert other_method.status_code == 409
    with pytest.raises(ValueError):
        parse_envelope(b"{}", "shipment.status_changed")


def test_idempotency_key_format_and_payment_fields(client, headers, body):
    bad = client.post("/orders", headers={**headers, "Idempotency-Key": "not-a-uuid"}, json=body)
    assert bad.status_code == 400 and bad.json()["error"] == "VALIDATION_ERROR"
    cvv = client.post("/orders", headers=headers, json={**body, "payment": {**body["payment"], "cvv": "123"}})
    assert cvv.status_code == 400
    assert not orders_in_db(client)


def test_same_key_while_first_attempt_runs_and_after_it_was_abandoned(client, deps, headers, body):
    """EM: second request with the same key — 503 while the first attempt owns NEW, continues after it expired."""
    deps.rules["inventory:POST"] = {"status": 503}  # sent: the reservation may exist, so it is released
    deps.rules["inventory:DELETE"] = {"error": httpx.ConnectError}
    assert client.post("/orders", headers=headers, json=body).status_code == 503  # compensation failed: NEW kept
    [order] = orders_in_db(client)
    factory = client.app.state.session_factory
    with factory.begin() as db:  # as if the first attempt were still running
        db.execute(update(Order).values(attempt_until=utcnow() + timedelta(seconds=5)))
    deps.rules.clear()
    calls = len(deps.calls)
    busy = client.post("/orders", headers=headers, json=body)
    assert busy.status_code == 503 and busy.json()["message"] == "Zakup jest w toku; ponów z tym samym kluczem"
    assert len(deps.calls) == calls  # no second reservation while the first attempt owns the order
    with factory.begin() as db:  # the first attempt was abandoned (process killed): its time passed
        db.execute(update(Order).values(attempt_until=utcnow() - timedelta(seconds=1)))
    finished = create(client, headers, body)
    assert finished["id"] == order.id and finished["status"] == "PAID"
    assert [e["type"] for e in outbox(client)] == ["order.created"]


def test_paid_is_answered_even_if_the_cart_fails(client, deps, headers, body):
    """S3: after PAID the answer is always 201 PAID; the cart is emptied once, without retries."""
    deps.rules["cart:DELETE"] = {"status": 503}
    assert create(client, headers, body)["status"] == "PAID"
    deps.rules["cart:DELETE"] = {"delay": 3}
    assert create(client, {**headers, "Idempotency-Key": str(uuid4())}, body)["status"] == "PAID"
    assert len(deps.made("cart", "DELETE")) == 2


def test_purchase_deadline_compensates(client, deps, headers, body, monkeypatch):
    """S4/D5: steps 1-5 over the deadline → reservation released, NEW deleted, 503."""
    from app import orders
    monkeypatch.setattr(orders, "PURCHASE_SECONDS", 1.2)  # the reservation still gets more than MIN_CALL_SECONDS
    monkeypatch.setattr(orders, "LATE_RELEASE_SECONDS", 0.1)
    deps.rules["inventory:POST"] = {"delay": 2}
    response = client.post("/orders", headers=headers, json=body)
    assert response.status_code == 503 and response.json()["message"].startswith("Zamówienie nie powstało")
    assert len(deps.made("inventory", "DELETE")) == 1 and not orders_in_db(client) and not outbox(client)
    # CR-3: the result of the reservation is unknown (timeout), so one more DELETE follows
    assert wait_until(lambda: len(deps.made("inventory", "DELETE")) == 2)


@pytest.mark.parametrize("service,rule,expected", [
    ("inventory:POST", {"status": 400}, 503),
    ("cart:GET", {"status": 404}, 503),
    ("cart:GET", {"status": 401}, 503),
    ("product:GET", {"status": 404}, 409),
    ("shipping:GET", {"status": 400}, 503),
    ("cart:GET", {"status": 200, "json": {"userId": None, "items": []}}, 409),
])
def test_dependency_refusals(client, deps, headers, body, caplog, service, rule, expected):
    """S6: only CART_EMPTY, PRODUCT_UNAVAILABLE and INSUFFICIENT_STOCK reach the client; other 4xx → 503 + error."""
    deps.rules[service] = rule
    caplog.set_level(logging.ERROR, logger="app")
    response = client.post("/orders", headers=headers, json=body)
    assert response.status_code == expected
    if expected == 503:
        errors = [r for r in caplog.records if r.levelno == logging.ERROR and r.name == "app.peers"]
        assert [r.fields["target"] for r in errors] == [service.split(":")[0]]
        assert errors[0].fields["status"] == rule["status"]
    assert not [o for o in orders_in_db(client) if o.status == "NEW"]
    if service == "inventory:POST":
        assert len(deps.made("inventory", "DELETE")) == 1  # compensation


def test_other_client_cannot_see_or_cancel(client, deps, headers, body):
    order = create(client, headers, body)
    other = {"X-User-Id": str(uuid4()), "X-User-Roles": "CUSTOMER"}
    assert client.get(f"/orders/{order['id']}", headers=other).status_code == 404
    assert client.post(f"/orders/{order['id']}/cancel", headers=other).status_code == 404
    assert client.get("/orders", headers=other).json()["total"] == 0
    assert not deps.made("shipping", "POST")
    assert store.get(client.app.state.session_factory, order["id"]).status == "PAID"


def wait_until(condition, seconds=3.0) -> bool:
    """For work the app finishes after the response (the late release of CR-3)."""
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if condition():
            return True
        time.sleep(0.02)
    return condition()


@pytest.mark.parametrize("rule", [{"error": httpx.ConnectError}, "open breaker"])
def test_reservation_not_sent_deletes_new_without_a_release(client, deps, headers, body, monkeypatch, caplog, rule):
    """CR-1: the reservation request never reached Inventory → nothing to release, NEW deleted, "not created"."""
    from app import orders
    monkeypatch.setattr(orders, "LATE_RELEASE_SECONDS", 0.05)
    caplog.set_level(logging.WARNING, logger="app")
    if rule == "open breaker":
        breaker = client.app.state.peers.breakers["inventory"]
        breaker.opened_at = breaker.clock()
    else:
        deps.rules["inventory:POST"] = rule
    response = client.post("/orders", headers=headers, json=body)
    assert response.status_code == 503 and response.json()["message"] == orders.NOT_CREATED
    assert not orders_in_db(client) and not outbox(client)
    time.sleep(0.2)  # no late release either
    assert not deps.made("inventory", "DELETE")
    assert not [r for r in caplog.records if getattr(r, "fields", {}).get("method") == "DELETE"]
    assert not [r for r in caplog.records if r.getMessage() == "Compensation failed, NEW order kept"]


def test_reservation_at_an_address_that_does_not_answer_is_not_sent(client, deps, headers, body, monkeypatch, caplog):
    """CR-1 round 2: Inventory stopped a moment ago, its address still listed — the connection hangs. The connect
    phase ends before the call limit as ConnectTimeout: never sent, so NEW deleted and no DELETE (which would hang too
    and keep NEW)."""
    from app import orders, peers
    monkeypatch.setattr(peers, "CONNECT_TIMEOUT", 0.1, raising=False)  # 1 s in the service; a shorter wait here
    monkeypatch.setattr(orders, "LATE_RELEASE_SECONDS", 0.05)
    caplog.set_level(logging.WARNING, logger="app")
    deps.rules["inventory:POST"] = deps.rules["inventory:DELETE"] = {"connect_hangs": True}
    response = client.post("/orders", headers=headers, json=body)
    assert response.status_code == 503 and response.json()["message"] == orders.NOT_CREATED
    assert not orders_in_db(client) and not outbox(client)
    time.sleep(0.2)  # no late release either
    assert len(deps.made("inventory", "POST")) == 3 and not deps.made("inventory", "DELETE")  # POST retried (Z22)
    reasons = [r.fields["reason"] for r in caplog.records if r.getMessage() == "Service unavailable"]
    assert reasons == ["ConnectTimeout"]


@pytest.mark.parametrize("rule,deletes", [
    ({"status": 503}, 2),                # sent, no answer about the result: release now and once more later
    ({"error": httpx.ReadTimeout}, 2),   # sent, the answer never came
    ({"status": 400}, 1),                # refused: nothing reserved, no late release
])
def test_late_release_only_when_the_reservation_result_is_unknown(client, deps, headers, body, monkeypatch, caplog,
                                                                  rule, deletes):
    """CR-3 (A4): Inventory may save a reservation after answering 503 (or after our timeout)."""
    from app import orders
    monkeypatch.setattr(orders, "LATE_RELEASE_SECONDS", 0.05)
    caplog.set_level(logging.INFO, logger="app")
    deps.rules["inventory:POST"] = rule
    response = client.post("/orders", headers=headers, json=body)
    assert response.status_code == 503 and response.json()["message"] == orders.NOT_CREATED
    assert wait_until(lambda: len(deps.made("inventory", "DELETE")) == deletes)
    time.sleep(0.2)
    released = deps.made("inventory", "DELETE")
    assert len(released) == deletes and len({r.url.path for r in released}) == 1
    late = [r for r in caplog.records if r.getMessage() == "Reservation released again after compensation"]
    assert len(late) == deletes - 1


def test_no_late_release_when_new_is_kept(client, deps, headers, body, monkeypatch):
    """CR-3: when the release fails, NEW stays for a retry with the same key, which needs the reservation."""
    from app import orders
    monkeypatch.setattr(orders, "LATE_RELEASE_SECONDS", 0.05)
    deps.rules["inventory:POST"] = {"status": 503}
    deps.rules["inventory:DELETE"] = {"status": 503}
    response = client.post("/orders", headers=headers, json=body)
    assert response.status_code == 503 and response.json()["message"] == orders.RETRY_SAME_KEY
    time.sleep(0.3)
    assert len(deps.made("inventory", "DELETE")) == 1 and [o.status for o in orders_in_db(client)] == ["NEW"]


@pytest.mark.parametrize("slow_step,message", [("create_new", "RETRY_SAME_KEY"), ("find_by_key", "NOT_CREATED")])
def test_deadline_before_the_reservation(client, deps, headers, body, monkeypatch, slow_step, message):
    """CR-5: a deadline during the save of NEW does not stop the thread, so NEW may appear: retry with the same key.
    A deadline before that (here: the lookup of the key) leaves nothing behind: "not created"."""
    from app import orders, store
    monkeypatch.setattr(orders, "PURCHASE_SECONDS", 1.0)  # enough for the snapshot (each call needs 0.5 s left)
    real = getattr(store, slow_step)

    def slow(*args):
        time.sleep(1.3)
        return real(*args)
    monkeypatch.setattr(store, slow_step, slow)
    response = client.post("/orders", headers=headers, json=body)
    assert response.status_code == 503 and response.json()["message"] == getattr(orders, message)
    time.sleep(0.6)  # the thread finishes its work
    assert [o.status for o in orders_in_db(client)] == (["NEW"] if slow_step == "create_new" else [])
    assert not deps.made("inventory", "POST")


def test_same_key_of_two_customers_gives_two_orders(client, deps, headers, body):
    """CR-8: Idempotency-Key is per customer; the same value from another customer is a different purchase."""
    first = create(client, headers, body)
    other = {**headers, "X-User-Id": str(uuid4())}  # the same Idempotency-Key
    second = create(client, other, body)
    assert first["id"] != second["id"] and second["userId"] == other["X-User-Id"]
    assert {o.user_id for o in orders_in_db(client)} == {headers["X-User-Id"], other["X-User-Id"]}
    assert client.get(f"/orders/{first['id']}", headers=other).status_code == 404
