import asyncio
import json
import logging
import time

import pytest

from app import db, service
from app.models import InventoryItem
from tests.conftest import ADMIN, CUSTOMER, O1, O2, O3, P1, P2, P_UNKNOWN, SERVICE


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
    assert reserve(client, O1, [(stocked, 6)]).status_code == 201
    resp = client.put(f"/inventory/{stocked}", json={"quantity": 5}, headers=ADMIN)
    assert resp.status_code == 409


# --- rezerwacje ------------------------------------------------------------

def test_reservation_requires_service_role(client, stocked):
    # endpoint wewnętrzny: bez roli SERVICE zawsze 403, także bez nagłówków
    assert reserve(client, O1, [(stocked, 1)], headers={}).status_code == 403
    assert reserve(client, O1, [(stocked, 1)], headers=CUSTOMER).status_code == 403
    assert reserve(client, O1, [(stocked, 1)], headers=ADMIN).status_code == 403


def test_reservation_reduces_available(client, stocked):
    resp = reserve(client, O1, [(stocked, 3)])
    assert resp.status_code == 201
    assert resp.json() == {"orderId": O1, "status": "ACTIVE", "items": [{"productId": stocked, "quantity": 3}]}
    s = stock(client, stocked)
    assert (s["reserved"], s["available"]) == (3, 7)


def test_repeated_reservation_for_same_order_is_idempotent(client, stocked):
    assert reserve(client, O1, [(stocked, 3)]).status_code == 201
    assert reserve(client, O1, [(stocked, 3)]).status_code == 200
    assert stock(client, stocked)["reserved"] == 3


def test_insufficient_stock_returns_409_and_changes_nothing(client, stocked):
    client.put(f"/inventory/{P2}", json={"quantity": 1}, headers=ADMIN)
    resp = reserve(client, O1, [(stocked, 2), (P2, 5)])
    assert resp.status_code == 409
    assert resp.json()["error"] == "INSUFFICIENT_STOCK"
    assert P2 in resp.json()["message"]
    assert stock(client, stocked)["reserved"] == 0  # rezerwacja jest atomowa
    assert stock(client, P2)["reserved"] == 0


def test_unknown_product_cannot_be_reserved(client):
    assert reserve(client, O1, [(P_UNKNOWN, 1)]).status_code == 409


def test_duplicate_items_in_one_request_are_summed(client, stocked):
    resp = reserve(client, O1, [(stocked, 2), (stocked, 3)])
    assert resp.status_code == 201
    assert resp.json()["items"] == [{"productId": stocked, "quantity": 5}]


def test_invalid_reservation_body(client):
    for body in (
        {"orderId": O1, "items": []},
        {"orderId": "", "items": [{"productId": P1, "quantity": 1}]},
        {"orderId": O1, "items": [{"productId": P1, "quantity": 0}]},
        {"orderId": O1, "items": [{"productId": "nie-uuid", "quantity": 1}]},
        {"orderId": O1, "items": [{"productId": 1, "quantity": 1}]},  # liczba zamiast UUID
        {"orderId": "not-a-uuid", "items": [{"productId": P1, "quantity": 1}]},
        {"orderId": "   ", "items": [{"productId": P1, "quantity": 1}]},
        {"orderId": 1, "items": [{"productId": P1, "quantity": 1}]},
        {"orderId": O1, "items": [{"productId": P1, "quantity": True}]},  # quantity ściśle liczbą całkowitą
        {"orderId": O1, "items": [{"productId": P1, "quantity": "10"}]},
        {"orderId": O1, "items": [{"productId": P1, "quantity": 1.5}]},
        {"orderId": O1, "items": [{"productId": P1, "quantity": 1}], "foo": 1},  # nieznane pole
        {"orderId": O1, "items": [{"productId": P1, "quantity": 1, "foo": 1}]},
    ):
        resp = client.post("/inventory/reservations", json=body, headers=SERVICE)
        assert resp.status_code == 400, body
        assert resp.json()["error"] == "VALIDATION_ERROR"


def test_release_restores_stock_and_is_idempotent(client, stocked):
    reserve(client, O1, [(stocked, 4)])
    assert client.delete(f"/inventory/reservations/{O1}", headers=SERVICE).status_code == 204
    assert stock(client, stocked)["available"] == 10
    assert client.delete(f"/inventory/reservations/{O1}", headers=SERVICE).status_code == 204
    assert stock(client, stocked)["available"] == 10


def test_released_order_cannot_be_reserved_again(client, stocked):
    reserve(client, O1, [(stocked, 1)])
    client.delete(f"/inventory/reservations/{O1}", headers=SERVICE)
    assert reserve(client, O1, [(stocked, 1)]).status_code == 409


def test_order_id_is_normalized_to_lowercase(client, stocked):
    assert reserve(client, O1.upper(), [(stocked, 2)]).status_code == 201
    second = reserve(client, O1, [(stocked, 2)])
    assert second.status_code == 200  # ten sam UUID = ta sama rezerwacja
    assert second.json()["orderId"] == O1
    assert stock(client, stocked)["reserved"] == 2
    # zwolnienie wielkimi literami zwalnia rezerwację założoną małymi
    assert client.delete(f"/inventory/reservations/{O1.upper()}", headers=SERVICE).status_code == 204
    assert stock(client, stocked)["reserved"] == 0


def test_release_with_invalid_order_id_returns_400(client):
    resp = client.delete("/inventory/reservations/not-a-uuid", headers=SERVICE)
    assert resp.status_code == 400
    assert resp.json()["error"] == "VALIDATION_ERROR"
    assert client.delete("/inventory/reservations/not-a-uuid", headers=CUSTOMER).status_code == 403  # rola przed treścią


def test_stock_quantity_must_be_a_strict_integer(client):
    for bad in (True, "10", 1.5):
        resp = client.put(f"/inventory/{P1}", json={"quantity": bad}, headers=ADMIN)
        assert resp.status_code == 400, bad


def test_release_requires_service_role(client):
    assert client.delete(f"/inventory/reservations/{O1}").status_code == 403
    assert client.delete(f"/inventory/reservations/{O1}", headers=CUSTOMER).status_code == 403


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


def _broken_session(exc):
    class Broken:
        info = {}  # db.run zapisuje tu termin

        def get(self, *args, **kwargs):
            raise exc

        def close(self):
            pass

    return lambda: Broken()


def test_database_errors_return_503_with_request_id(client, monkeypatch):
    from sqlalchemy.exc import OperationalError
    from sqlalchemy.exc import TimeoutError as PoolTimeout

    for exc in (OperationalError("SELECT 1", {}, Exception("connection refused")), PoolTimeout("pool exhausted")):
        monkeypatch.setattr(db._State, "factory", _broken_session(exc))
        resp = client.get(f"/inventory/{P1}", headers={"X-Request-Id": "req-db"})
        assert resp.status_code == 503, type(exc).__name__
        assert resp.json() == {
            "status": 503,
            "error": "SERVICE_UNAVAILABLE",
            "message": "Baza danych niedostępna",
            "requestId": "req-db",
        }
        assert resp.headers["X-Request-Id"] == "req-db"


def test_database_that_does_not_answer_gives_503(client, stocked, monkeypatch):
    # zawieszona baza: zapytanie wisi (tu: sleep w wątku), a żądanie dostaje 503 po DB_CALL_TIMEOUT
    monkeypatch.setattr(db, "DB_CALL_TIMEOUT", 0.2)
    original = db.session_scope

    def hanging_scope():
        time.sleep(0.5)
        return original()

    monkeypatch.setattr(db, "session_scope", hanging_scope)
    resp = client.get(f"/inventory/{stocked}")
    assert resp.status_code == 503
    assert resp.json()["error"] == "SERVICE_UNAVAILABLE"


def test_db_run_gives_up_after_timeout_without_waiting_for_the_thread(engine, monkeypatch):
    monkeypatch.setattr(db, "DB_CALL_TIMEOUT", 0.2)

    async def scenario():
        start = time.perf_counter()
        with pytest.raises(db.DatabaseTimeout):
            await db.run(lambda session: time.sleep(0.6))
        return time.perf_counter() - start

    assert asyncio.run(scenario()) < 0.4


def _run_and_wait_for_thread(work, wait=0.6):
    """db.run z limitem 0,2 s; po 503 czeka, aż wątek skończy pracę (baza "wróciła")."""
    async def scenario():
        with pytest.raises(db.DatabaseTimeout):
            await db.run(work)
        await asyncio.sleep(wait)

    asyncio.run(scenario())


def test_work_finishing_after_the_deadline_is_rolled_back(engine, monkeypatch, caplog):
    # CR-3: wołający dostał 503, więc spóźniony wątek nie może zapisać zmian (np. rezerwacji po kompensacji Order)
    monkeypatch.setattr(db, "DB_CALL_TIMEOUT", 0.2)

    def slow_write(session):
        time.sleep(0.4)  # zapytania trwają dłużej niż limit
        service.set_stock(session, P1, 5)

    with caplog.at_level(logging.WARNING, logger="app.db"):
        _run_and_wait_for_thread(slow_write)
    with db.session_scope() as session:
        assert session.get(InventoryItem, P1) is None
    assert [r.getMessage() for r in caplog.records if r.name == "app.db"] == [
        "Operacja na bazie skończyła się po limicie 0.2 s, zmiany wycofane"]


def test_deadline_is_counted_from_the_call_not_from_the_thread_start(engine, monkeypatch):
    # wątek z puli rusza z opóźnieniem (tu: wolne otwarcie sesji), a sam zapis jest szybki - i tak po terminie
    monkeypatch.setattr(db, "DB_CALL_TIMEOUT", 0.2)
    original = db.session_scope

    def late_scope():
        time.sleep(0.3)
        return original()

    monkeypatch.setattr(db, "session_scope", late_scope)
    _run_and_wait_for_thread(lambda session: service.set_stock(session, P1, 5))
    monkeypatch.setattr(db, "session_scope", original)
    with db.session_scope() as session:
        assert session.get(InventoryItem, P1) is None


def test_work_within_the_deadline_is_committed(engine):
    asyncio.run(db.run(lambda session: service.set_stock(session, P1, 5)))
    with db.session_scope() as session:
        assert session.get(InventoryItem, P1).quantity == 5


def test_sessions_without_deadline_are_not_limited(engine):
    # odbiorca zdarzeń używa session_scope bez db.run: ma własne ponowienia, nie limit 2 s
    with db.session_scope() as session:
        time.sleep(0.05)
        service.set_stock(session, P1, 3)
    with db.session_scope() as session:
        assert session.get(InventoryItem, P1).quantity == 3


def test_postgres_connections_get_lock_and_statement_timeouts_below_2s(monkeypatch):
    captured = {}
    monkeypatch.setattr(db, "create_engine", lambda url, **kwargs: captured.update(kwargs) or "engine")
    monkeypatch.setattr(db, "configure", lambda engine: None)
    db.init_engine("postgresql+psycopg2://user@host/inventory_db")
    assert captured["connect_args"]["options"] == "-c lock_timeout=1500 -c statement_timeout=1800"
    assert captured["connect_args"]["connect_timeout"] == 2


def test_postgres_connections_drop_a_vanished_server_within_seconds(monkeypatch):
    # CR-13: Postgres odłączony od sieci - bez keepalive i tcp_user_timeout odbiorca wisiałby bez błędu
    captured = {}
    monkeypatch.setattr(db, "create_engine", lambda url, **kwargs: captured.update(kwargs) or "engine")
    monkeypatch.setattr(db, "configure", lambda engine: None)
    db.init_engine("postgresql+psycopg2://user@host/inventory_db")
    args = captured["connect_args"]
    assert {k: args[k] for k in ("keepalives", "keepalives_idle", "keepalives_interval", "keepalives_count",
                                 "tcp_user_timeout")} == {"keepalives": 1, "keepalives_idle": 5, "keepalives_interval": 2,
                                                          "keepalives_count": 2, "tcp_user_timeout": 5000}


def test_sqlite_gets_no_postgres_connect_args(monkeypatch):
    captured = {}
    monkeypatch.setattr(db, "create_engine", lambda url, **kwargs: captured.update(kwargs) or "engine")
    monkeypatch.setattr(db, "configure", lambda engine: None)
    db.init_engine("sqlite://")
    assert captured["connect_args"] == {}


def test_live_does_not_touch_the_database(client, monkeypatch):
    monkeypatch.setattr(db._State, "factory", None)
    monkeypatch.setattr(db._State, "engine", None)
    assert client.get("/health/live").status_code == 200


def test_ready_returns_503_when_database_does_not_answer(client, monkeypatch):
    from app import api

    monkeypatch.setattr(api, "READY_DB_TIMEOUT", 0.1)
    monkeypatch.setattr(db, "ping", lambda: time.sleep(0.4))
    assert client.get("/health/ready").status_code == 503


def test_unhandled_error_log_has_request_id(client, monkeypatch):
    from app.logging_config import JsonFormatter

    lines = []

    class Capture(logging.Handler):
        def emit(self, record):  # format od razu: requestId pochodzi z kontekstu w chwili zapisu
            lines.append(json.loads(JsonFormatter("inventory-service").format(record)))

    handler = Capture()
    logging.getLogger("app.errors").addHandler(handler)
    monkeypatch.setattr(db._State, "factory", _broken_session(ValueError("secret detail")))
    try:
        resp = type(client)(client.app, raise_server_exceptions=False).get(
            f"/inventory/{P1}", headers={"X-Request-Id": "req-500"}
        )
    finally:
        logging.getLogger("app.errors").removeHandler(handler)
    assert resp.status_code == 500
    assert resp.json()["requestId"] == "req-500"
    assert [line["requestId"] for line in lines] == ["req-500"]
    assert lines[0]["reason"] == "ValueError" and "secret detail" not in json.dumps(lines)


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
        resp = reserve(client, O1, [(stocked, 1)], headers={"X-User-Roles": roles})
        assert resp.status_code == 403, roles
    # usługa wołająca w imieniu klienta dopisuje SERVICE do ról
    caller = {"X-User-Id": CUSTOMER["X-User-Id"], "X-User-Roles": "CUSTOMER,SERVICE"}
    assert reserve(client, O2, [(stocked, 1)], headers=caller).status_code == 201
    spaced = {"X-User-Roles": " CUSTOMER , SERVICE "}  # spacje wokół nazw są pomijane
    assert reserve(client, O3, [(stocked, 1)], headers=spaced).status_code == 201


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


def test_tables_have_names_that_differ_from_the_old_schema():
    # stare tabele (product_id BIGINT) zostają nieużywane; create_all zakłada nowe przy starcie
    from app.models import Base

    assert set(Base.metadata.tables) == {"stock_items", "stock_reservations", "processed_events"}


def test_malformed_database_url_error_does_not_contain_the_password(caplog):
    for url in ("postgresql+psycopg2//inv:tajne-haslo@host/db", "nieznany://inv:tajne-haslo@host/db",
                "postgresql+psycopg2://inv:tajne-haslo@host:abc/db"):
        with pytest.raises(RuntimeError) as info:
            db.init_engine(url)
        assert "tajne-haslo" not in str(info.value) and info.value.__cause__ is None and info.value.__suppress_context__
    assert "tajne-haslo" not in caplog.text
