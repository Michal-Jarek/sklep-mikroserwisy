"""Row locks need PostgreSQL (SQLite has none): run with SHIPPING_TEST_DB_URL pointing to an empty test database,
e.g. postgresql+psycopg://shipping_service:<password>@127.0.0.1:5432/shipping_test. Skipped otherwise.
Never the database of a running Shipping: its outbox relay would publish the test events to shop.events."""
import json
import os
import random
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from sqlalchemy import create_engine, select, text
from sqlalchemy.engine import make_url

from app.config import Settings
from app.events import handle, parse_envelope
from app.main import create_app
from app.models import Outbox
from app.relay import lease_rows

DB_URL = os.environ.get("SHIPPING_TEST_DB_URL")
pytestmark = pytest.mark.skipif(not DB_URL, reason="SHIPPING_TEST_DB_URL not set")
ADMIN = {"X-User-Id": str(uuid4()), "X-User-Roles": "ADMIN"}
SERVICE = {"X-User-Id": str(uuid4()), "X-User-Roles": "CUSTOMER,SERVICE"}


def created_event(order_id, user_id):
    return {"type": "order.created", "version": 1, "eventId": str(uuid4()), "requestId": "race",
            "occurredAt": "2026-11-14T09:00:00.000Z", "payload": {
                "orderId": order_id, "userId": user_id, "shippingCost": "9.99", "shippingMethod": "PARCEL_LOCKER",
                "currency": "PLN", "shippingAddress": {"firstName": "A", "lastName": "B", "street": "C 1",
                                                       "city": "D", "postalCode": "00-001", "countryCode": "PL"}}}


def test_cancel_and_dispatch_race():
    app = create_app(Settings(db_url=DB_URL, consul_enabled=False, broker_enabled=False))
    with TestClient(app) as client, ThreadPoolExecutor(2) as pool:
        factory = app.state.session_factory
        for _ in range(20):
            order_id, user_id = str(uuid4()), str(uuid4())
            event = created_event(order_id, user_id)
            handle(factory, parse_envelope(json.dumps(event).encode(), event["type"]))
            shipment, = client.get("/shipments", headers=ADMIN, params={"orderId": order_id}).json()["items"]
            start = threading.Barrier(2)

            def cancel():
                start.wait()
                return client.post("/shipments/cancel", headers=SERVICE, json={"orderId": order_id})

            def dispatch():
                start.wait()
                return client.patch(f"/shipments/{shipment['id']}/status", headers=ADMIN, json={"status": "SHIPPED"})

            cancelled, dispatched = (f.result() for f in [pool.submit(cancel), pool.submit(dispatch)])
            codes = sorted([cancelled.status_code, dispatched.status_code])
            assert codes == [200, 409]
            final = client.get(f"/shipments/{shipment['id']}", headers=ADMIN).json()["status"]
            assert final == ("CANCELLED" if cancelled.status_code == 200 else "SHIPPED")


def test_duplicate_event_is_recognized():
    # rowcount of INSERT ... ON CONFLICT DO NOTHING is -1 with psycopg, so only RETURNING tells a duplicate apart.
    app = create_app(Settings(db_url=DB_URL, consul_enabled=False, broker_enabled=False))
    with TestClient(app):
        factory = app.state.session_factory
        order_id = str(uuid4())
        event = parse_envelope(json.dumps(created_event(order_id, str(uuid4()))).encode(), "order.created")
        assert handle(factory, event) == ("processed", order_id)
        assert handle(factory, event) == ("duplicate", order_id)


def events_of(factory, order_id):
    with factory() as db:
        rows = db.scalars(select(Outbox).order_by(Outbox.seq)).all()
        return [(r.envelope["payload"]["oldStatus"], r.envelope["payload"]["newStatus"])
                for r in rows if r.envelope["payload"]["orderId"] == order_id]


def test_cancel_and_creation_race():
    # CR-11: POST /shipments/cancel (no shipment yet) against order.created. Both orders are allowed (Z10):
    # cancel first -> CANCELLED with one event null->CANCELLED; creation first -> PREPARING->CANCELLED, two events.
    app = create_app(Settings(db_url=DB_URL, consul_enabled=False, broker_enabled=False))
    outcomes = {"cancel first": 0, "creation first": 0}
    with TestClient(app) as client, ThreadPoolExecutor(2) as pool:
        factory = app.state.session_factory
        for round_no in range(20):
            order_id, user_id = str(uuid4()), str(uuid4())
            event = parse_envelope(json.dumps(created_event(order_id, user_id)).encode(), "order.created")
            start = threading.Barrier(2)
            # The HTTP call is slower than a direct handle(): the side released later alternates (0-20 ms),
            # so both outcomes occur in a run.
            delay_cancel, delay_create = (random.uniform(0, 0.02), 0) if round_no % 2 else (0, random.uniform(0, 0.02))

            def cancel():
                start.wait()
                time.sleep(delay_cancel)
                return client.post("/shipments/cancel", headers=SERVICE, json={"orderId": order_id})

            def create():
                start.wait()
                time.sleep(delay_create)
                return handle(factory, event)

            cancelled, created = (f.result() for f in [pool.submit(cancel), pool.submit(create)])
            assert cancelled.status_code == 200 and created == ("processed", order_id)
            shipment, = client.get("/shipments", headers=ADMIN, params={"orderId": order_id}).json()["items"]
            assert shipment["status"] == "CANCELLED" and shipment["userId"] == user_id
            events = events_of(factory, order_id)
            if events == [(None, "CANCELLED")]:
                outcomes["cancel first"] += 1
            else:
                assert events == [(None, "PREPARING"), ("PREPARING", "CANCELLED")]
                outcomes["creation first"] += 1
    print(f"race cancel || order.created, 20 rounds: {outcomes}")


PR17_TABLES = """
CREATE TABLE shipments (order_id varchar(36) PRIMARY KEY, user_id varchar(36) NOT NULL, id varchar(36) UNIQUE,
    tracking varchar(34) UNIQUE, status varchar(16) NOT NULL, destination json, method varchar(24),
    cost varchar(20), currency varchar(3));
CREATE INDEX ix_shipments_user_id ON shipments (user_id);
CREATE TABLE shipping_history (seq serial PRIMARY KEY, shipment_id varchar(36) NOT NULL,
    status varchar(16) NOT NULL, at varchar(32) NOT NULL);
CREATE TABLE shipping_processed (id varchar(36) PRIMARY KEY);
CREATE TABLE shipping_outbox (seq serial PRIMARY KEY, envelope json NOT NULL);
INSERT INTO shipping_outbox (envelope) VALUES ('{"payload": {"orderId": "pr17"}}');
"""


def test_tables_from_pr17_are_migrated_at_start():
    # CR-2: tables created by the version from PR #17 (user_id NOT NULL, no locked_until) in their own schema.
    schema = f"pr17_{uuid4().hex[:8]}"
    admin = create_engine(DB_URL)
    with admin.begin() as connection:
        connection.execute(text(f"CREATE SCHEMA {schema}"))
        connection.execute(text(f"SET LOCAL search_path TO {schema}"))
        for statement in filter(str.strip, PR17_TABLES.split(";")):
            connection.execute(text(statement))
    url = make_url(DB_URL).update_query_dict({"options": f"-csearch_path={schema}"})
    try:
        for start in range(2):  # the second start finds migrated tables: nothing to do, no error
            app = create_app(Settings(db_url=url.render_as_string(hide_password=False),
                                      consul_enabled=False, broker_enabled=False))
            with TestClient(app) as client:
                response = client.post("/shipments/cancel", headers=SERVICE, json={"orderId": str(uuid4())})
                assert response.status_code == 200 and response.json()["shipmentId"] is None
                if start == 0:
                    assert len(lease_rows(app.state.session_factory)) == 1  # the relay can take the old row
        with admin.connect() as connection:
            columns = dict(connection.execute(text(
                "SELECT column_name, is_nullable FROM information_schema.columns "
                "WHERE table_schema = :s AND column_name IN ('user_id', 'locked_until')"), {"s": schema}).all())
        assert columns == {"user_id": "YES", "locked_until": "YES"}
    finally:
        with admin.begin() as connection:
            connection.execute(text(f"DROP SCHEMA {schema} CASCADE"))
        admin.dispose()
