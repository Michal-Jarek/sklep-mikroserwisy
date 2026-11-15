"""Behaviour SQLite does not show (rowcount of INSERT ... ON CONFLICT, row locks, the schema migration): run with
ORDER_TEST_DB_URL pointing to a test database, never the database of a running service (README "Testy"). The role needs
CREATE on the database (the migration test works in its own schema). Skipped without the variable."""
import os
import time
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, text

from app import consumer, store
from app.config import Settings
from app.database import create_schema, make_factory
from app.events import handle, parse_envelope
from app.main import create_app
from tests.test_events import FakeMessage, run
from tests.test_orders import shipment_event

DB_URL = os.environ.get("ORDER_TEST_DB_URL")
pytestmark = pytest.mark.skipif(not DB_URL, reason="ORDER_TEST_DB_URL not set")


@pytest.fixture(scope="module")
def factory():
    app = create_app(Settings(db_url=DB_URL, consul_enabled=False, broker_enabled=False))
    with TestClient(app):
        assert app.state.session_factory.kw["bind"].dialect.name == "postgresql"
        yield app.state.session_factory


def mark(factory, event_id: str) -> bool:
    with factory.begin() as db:
        return store.mark_processed(db, event_id)


def test_duplicate_event_id_is_recognized(factory):
    # rowcount of INSERT ... ON CONFLICT DO NOTHING is -1 with psycopg, so only RETURNING tells a duplicate apart.
    event_id = str(uuid4())
    assert mark(factory, event_id) is True
    assert mark(factory, event_id) is False
    assert mark(factory, str(uuid4())) is True


def test_parallel_delivery_of_the_same_event_id_is_processed_once(factory):
    event_id = str(uuid4())
    with ThreadPoolExecutor(1) as pool, factory.begin() as first:
        assert store.mark_processed(first, event_id) is True
        second = pool.submit(mark, factory, event_id)
        time.sleep(0.5)
        assert not second.done()  # waits for the first transaction
    assert second.result(timeout=5) is False


def test_duplicate_shipment_event_is_handled_once(factory, caplog):
    raw = shipment_event(str(uuid4()), str(uuid4()), "SHIPPED")  # unknown order: handling logs one warning
    outcomes = [handle(factory, parse_envelope(raw, "shipment.status_changed")) for _ in range(2)]
    assert outcomes == ["processed", "duplicate"]
    assert [r.msg for r in caplog.records if r.levelname == "WARNING"] == ["Shipment status for an unknown order"]


def test_conditional_updates_report_one_or_zero_rows(factory):
    order, _ = store.create_new(factory, str(uuid4()), str(uuid4()), {"items": []})
    assert store.claim(factory, order.id) is False  # attempt of create_new still running
    store.release_claim(factory, order.id)
    assert store.claim(factory, order.id) is True
    assert store.claim(factory, order.id) is False
    assert store.change_status(factory, order.id, ("NEW",), "PAID") is not None
    assert store.change_status(factory, order.id, ("NEW",), "PAID") is None
    other, _ = store.create_new(factory, str(uuid4()), str(uuid4()), {"items": []})
    assert store.delete_new(factory, other.id) is True
    assert store.delete_new(factory, other.id) is False


def test_consumer_logs_processed_then_duplicate(factory, json_logs):
    raw = shipment_event(str(uuid4()), str(uuid4()), "SHIPPED")
    for _ in range(2):  # the same message delivered twice
        message = FakeMessage(raw)
        run(consumer.on_message(message, partial(handle, factory)))
        assert message.result == "ack"
    assert [line["msg"] for line in json_logs if line["level"] == "info"] == [
        "Event processed", "Event already processed (duplicate eventId), acknowledged"]


# Tables as the first version created them (PR #17, develop dbafe3e: app/models.py).
PR17_TABLES = """
CREATE TABLE orders (id VARCHAR(36) NOT NULL PRIMARY KEY, user_id VARCHAR(36) NOT NULL,
    checkout_key VARCHAR(36) NOT NULL, status VARCHAR(30) NOT NULL, snapshot JSON NOT NULL,
    UNIQUE (user_id, checkout_key));
CREATE INDEX ix_orders_user_id ON orders (user_id);
CREATE TABLE order_outbox (seq SERIAL PRIMARY KEY, envelope JSON NOT NULL);
CREATE TABLE order_processed (id VARCHAR(36) PRIMARY KEY);
"""


def test_tables_of_pr17_are_migrated_at_start():
    """CR-2 (A1): orders without attempt_until (PR #17) gets the column at start; a second start changes nothing."""
    schema = f"pr17_{uuid4().hex[:8]}"
    admin = create_engine(DB_URL)
    with admin.begin() as connection:
        connection.execute(text(f"CREATE SCHEMA {schema}"))
    engine = create_engine(DB_URL, connect_args={"options": f"-csearch_path={schema}"})
    try:
        with engine.begin() as connection:
            connection.exec_driver_sql(PR17_TABLES)
            connection.execute(text("INSERT INTO orders VALUES ('o-1', 'u-1', 'k-1', 'PAID', '{\"items\": []}')"))
        create_schema(engine)
        create_schema(engine)  # the next start: idempotent
        columns = {column["name"] for column in inspect(engine).get_columns("orders")}
        assert "attempt_until" in columns
        assert {"outbox_events", "order_outbox", "order_processed"} <= set(inspect(engine).get_table_names())
        factory = make_factory(engine)
        assert store.get(factory, "o-1").status == "PAID"  # old rows stay readable
        order, created = store.create_new(factory, str(uuid4()), str(uuid4()), {"items": []})
        assert created and store.claim(factory, order.id) is False  # attempt_until works
    finally:
        engine.dispose()
        with admin.begin() as connection:
            connection.execute(text(f"DROP SCHEMA {schema} CASCADE"))
        admin.dispose()
