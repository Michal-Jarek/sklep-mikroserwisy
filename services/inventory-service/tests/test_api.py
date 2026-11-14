from tests.conftest import ADMIN, CUSTOMER, P1, P2, P_UNKNOWN, SERVICE


def reserve(client, order_id, items, headers=SERVICE):
    return client.post(
        "/inventory/reservations",
        json={"orderId": order_id, "items": [{"productId": p, "quantity": q} for p, q in items]},
        headers=headers,
    )


def stock(client, product_id):
    return client.get(f"/inventory/{product_id}").json()


# --- stany -----------------------------------------------------------------

def test_unknown_product_returns_404_in_team_error_format(client):
    resp = client.get(f"/inventory/{P_UNKNOWN}", headers={"X-Request-Id": "req-1"})
    assert resp.status_code == 404
    body = resp.json()
    assert body["status"] == 404
    assert body["error"] == "NOT_FOUND"
    assert body["requestId"] == "req-1"
    assert resp.headers["X-Request-Id"] == "req-1"
    assert "X-Instance-Id" in resp.headers


def test_invalid_uuid_in_path_returns_400(client):
    for bad in ("123", "abc", "3f0c9b1e6a524a8e9c1f0b2f7e1d5a77"):
        resp = client.get(f"/inventory/{bad}")
        assert resp.status_code == 400, bad
        assert resp.json()["error"] == "VALIDATION_ERROR"
    assert client.put("/inventory/abc", json={"quantity": 5}, headers=ADMIN).status_code == 400


def test_uppercase_uuid_is_normalized(client):
    client.put(f"/inventory/{P1.upper()}", json={"quantity": 5}, headers=ADMIN)
    assert stock(client, P1)["productId"] == P1


def test_put_requires_authentication_and_admin_role(client):
    url = f"/inventory/{P1}"
    assert client.put(url, json={"quantity": 5}).status_code == 401
    assert client.put(url, json={"quantity": 5}, headers=CUSTOMER).status_code == 403
    # sama rola SERVICE bez X-User-Id to brak logowania
    assert client.put(url, json={"quantity": 5}, headers=SERVICE).status_code == 401


def test_admin_sets_and_reads_stock(client):
    resp = client.put(f"/inventory/{P1}", json={"quantity": 5}, headers=ADMIN)
    assert resp.status_code == 200
    assert resp.json() == {"productId": P1, "quantity": 5, "reserved": 0, "available": 5, "inStock": True}
    assert stock(client, P1)["available"] == 5


def test_zero_quantity_means_out_of_stock(client):
    client.put(f"/inventory/{P1}", json={"quantity": 0}, headers=ADMIN)
    assert stock(client, P1)["inStock"] is False


def test_negative_quantity_is_rejected(client):
    resp = client.put(f"/inventory/{P1}", json={"quantity": -1}, headers=ADMIN)
    assert resp.status_code == 400
    assert resp.json()["error"] == "VALIDATION_ERROR"


def test_cannot_lower_stock_below_reserved(client, stocked):
    assert reserve(client, "o1", [(stocked, 6)]).status_code == 201
    resp = client.put(f"/inventory/{stocked}", json={"quantity": 5}, headers=ADMIN)
    assert resp.status_code == 409


# --- rezerwacje ------------------------------------------------------------

def test_reservation_requires_service_role(client, stocked):
    # endpoint wewnętrzny: bez roli SERVICE zawsze 403, także bez nagłówków
    assert reserve(client, "o1", [(stocked, 1)], headers={}).status_code == 403
    assert reserve(client, "o1", [(stocked, 1)], headers=CUSTOMER).status_code == 403
    assert reserve(client, "o1", [(stocked, 1)], headers=ADMIN).status_code == 403


def test_reservation_reduces_available(client, stocked):
    resp = reserve(client, "o1", [(stocked, 3)])
    assert resp.status_code == 201
    assert resp.json() == {"orderId": "o1", "status": "ACTIVE", "items": [{"productId": stocked, "quantity": 3}]}
    s = stock(client, stocked)
    assert (s["reserved"], s["available"]) == (3, 7)


def test_repeated_reservation_for_same_order_is_idempotent(client, stocked):
    assert reserve(client, "o1", [(stocked, 3)]).status_code == 201
    assert reserve(client, "o1", [(stocked, 3)]).status_code == 200
    assert stock(client, stocked)["reserved"] == 3


def test_insufficient_stock_returns_409_and_changes_nothing(client, stocked):
    client.put(f"/inventory/{P2}", json={"quantity": 1}, headers=ADMIN)
    resp = reserve(client, "o1", [(stocked, 2), (P2, 5)])
    assert resp.status_code == 409
    assert resp.json()["error"] == "INSUFFICIENT_STOCK"
    assert P2 in resp.json()["message"]
    assert stock(client, stocked)["reserved"] == 0  # rezerwacja jest atomowa
    assert stock(client, P2)["reserved"] == 0


def test_unknown_product_cannot_be_reserved(client):
    assert reserve(client, "o1", [(P_UNKNOWN, 1)]).status_code == 409


def test_duplicate_items_in_one_request_are_summed(client, stocked):
    resp = reserve(client, "o1", [(stocked, 2), (stocked, 3)])
    assert resp.status_code == 201
    assert resp.json()["items"] == [{"productId": stocked, "quantity": 5}]


def test_invalid_reservation_body(client):
    for body in (
        {"orderId": "o1", "items": []},
        {"orderId": "", "items": [{"productId": P1, "quantity": 1}]},
        {"orderId": "o1", "items": [{"productId": P1, "quantity": 0}]},
        {"orderId": "o1", "items": [{"productId": "nie-uuid", "quantity": 1}]},
        {"orderId": "o1", "items": [{"productId": 1, "quantity": 1}]},  # liczba zamiast UUID
    ):
        resp = client.post("/inventory/reservations", json=body, headers=SERVICE)
        assert resp.status_code == 400, body
        assert resp.json()["error"] == "VALIDATION_ERROR"


def test_release_restores_stock_and_is_idempotent(client, stocked):
    reserve(client, "o1", [(stocked, 4)])
    assert client.delete("/inventory/reservations/o1", headers=SERVICE).status_code == 204
    assert stock(client, stocked)["available"] == 10
    assert client.delete("/inventory/reservations/o1", headers=SERVICE).status_code == 204
    assert stock(client, stocked)["available"] == 10


def test_released_order_cannot_be_reserved_again(client, stocked):
    reserve(client, "o1", [(stocked, 1)])
    client.delete("/inventory/reservations/o1", headers=SERVICE)
    assert reserve(client, "o1", [(stocked, 1)]).status_code == 409


def test_release_requires_service_role(client):
    assert client.delete("/inventory/reservations/o1").status_code == 403
    assert client.delete("/inventory/reservations/o1", headers=CUSTOMER).status_code == 403


# --- health ----------------------------------------------------------------

def test_health_endpoints(client):
    assert client.get("/health/live").json() == {"status": "UP"}
    assert client.get("/health/ready").json() == {"status": "UP"}


def test_ready_returns_503_when_database_is_down(client, monkeypatch):
    from app import db

    def broken():
        raise RuntimeError("db down")

    monkeypatch.setattr(db, "ping", broken)
    resp = client.get("/health/ready")
    assert resp.status_code == 503
    assert resp.json()["error"] == "SERVICE_UNAVAILABLE"


def test_unknown_field_in_body_is_rejected(client):
    resp = client.put(f"/inventory/{P1}", json={"quantity": 5, "foo": 1}, headers=ADMIN)
    assert resp.status_code == 400
    assert resp.json()["error"] == "VALIDATION_ERROR"


def test_database_connection_error_returns_503_with_request_id(client):
    from sqlalchemy.exc import OperationalError

    from app.db import get_db
    from app.main import app

    def broken_db():
        raise OperationalError("SELECT 1", {}, Exception("connection refused"))
        yield  # noqa: B901 - dependency w postaci generatora

    app.dependency_overrides[get_db] = broken_db
    try:
        resp = client.get(f"/inventory/{P1}", headers={"X-Request-Id": "req-db"})
    finally:
        app.dependency_overrides.pop(get_db, None)
    assert resp.status_code == 503
    assert resp.json() == {
        "status": 503,
        "error": "SERVICE_UNAVAILABLE",
        "message": "Baza danych niedostępna",
        "requestId": "req-db",
    }
    assert resp.headers["X-Request-Id"] == "req-db"


def test_ready_returns_503_only_when_consumer_task_has_finished(client, monkeypatch):
    from app.main import app

    class Task:
        def __init__(self, finished):
            self._finished = finished

        def done(self):
            return self._finished

    monkeypatch.setattr(app.state, "consumer_task", Task(False), raising=False)
    assert client.get("/health/ready").status_code == 200  # działający odbiorca nie zmienia gotowości
    monkeypatch.setattr(app.state, "consumer_task", Task(True), raising=False)
    assert client.get("/health/ready").status_code == 503


# --- tożsamość i nagłówki (D11) ----------------------------------------------

def test_user_id_must_be_uuid(client, stocked):
    headers = {"X-User-Id": "nie-uuid", "X-User-Roles": "ADMIN"}
    resp = client.put(f"/inventory/{stocked}", json={"quantity": 5}, headers=headers)
    assert resp.status_code == 400
    assert resp.json()["error"] == "VALIDATION_ERROR"


def test_roles_are_a_case_sensitive_set(client, stocked):
    for roles in ("service", "XSERVICE", "CUSTOMER SERVICE", "SERVICE_X"):
        resp = reserve(client, "o-bad", [(stocked, 1)], headers={"X-User-Roles": roles})
        assert resp.status_code == 403, roles
    # usługa wołająca w imieniu klienta dopisuje SERVICE do ról
    caller = {"X-User-Id": CUSTOMER["X-User-Id"], "X-User-Roles": "CUSTOMER,SERVICE"}
    assert reserve(client, "o-ok", [(stocked, 1)], headers=caller).status_code == 201
    spaced = {"X-User-Roles": " CUSTOMER , SERVICE "}  # spacje wokół nazw są pomijane
    assert reserve(client, "o-ok2", [(stocked, 1)], headers=spaced).status_code == 201


def test_request_id_is_validated(client):
    ok = client.get("/health/live", headers={"X-Request-Id": "test-1"})
    assert ok.headers["X-Request-Id"] == "test-1"
    for bad in ("zly id ze spacja", "a/b", "x" * 65):
        resp = client.get("/health/live", headers={"X-Request-Id": bad})
        assert resp.headers["X-Request-Id"] != bad
        assert len(resp.headers["X-Request-Id"]) == 36  # nowy UUID


def test_trailing_slash_is_404_not_a_redirect(client):
    resp = client.get(f"/inventory/{P1}/", follow_redirects=False)
    assert resp.status_code == 404
    assert resp.json()["error"] == "NOT_FOUND"


def test_head_works_like_get(client, stocked):
    assert client.head(f"/inventory/{stocked}").status_code == 200
    assert client.head(f"/inventory/{P_UNKNOWN}").status_code == 404
