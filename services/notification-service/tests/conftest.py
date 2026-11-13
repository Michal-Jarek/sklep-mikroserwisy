"""Tests run without RabbitMQ, MongoDB, SMTP or User Service: fakes below replace them."""

import asyncio
import json
import uuid
from datetime import UTC, datetime

import httpx
import pytest

from app.config import Settings
from app.consul import Discovery
from app.consumer import Consumer
from app.users import USER_SERVICE, UserClient

CUSTOMER = "0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e"
ORDER = "5d7e9f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a"


class FakeStore:
    def __init__(self):
        self.entries: list[dict] = []
        self.fail_reads = 0
        self.fail_records = 0
        self.ready = True

    async def ensure_indexes(self):
        pass

    async def ping(self):
        return self.ready

    async def is_processed(self, event_id):
        if self.fail_reads:
            self.fail_reads -= 1
            raise ConnectionError("mongo down")
        return any(e["eventId"] == event_id for e in self.entries)

    async def record(self, entry):
        if self.fail_records:
            self.fail_records -= 1
            raise ConnectionError("mongo down")
        if any(e["eventId"] == entry["eventId"] for e in self.entries):
            return False
        self.entries.append(entry)
        return True

    async def list_for_user(self, user_id, page, size):
        rows = sorted((e for e in self.entries if e["userId"] == user_id), key=lambda e: e["sentAt"], reverse=True)
        return rows[(page - 1) * size: page * size], len(rows)

    def close(self):
        pass


class FakeMailer:
    def __init__(self):
        self.sent = []
        self.failures = 0

    async def send(self, mail):
        if self.failures:
            self.failures -= 1
            raise ConnectionRefusedError("smtp down")
        self.sent.append(mail)


class FakeUser:
    """Answers of User Service (GET /users/{id}); records the requests."""

    def __init__(self):
        self.requests: list[httpx.Request] = []
        self.answer = lambda request: httpx.Response(200, json={
            "id": CUSTOMER, "firstName": "Anna", "lastName": "Nowak", "email": "anna.nowak@example.com"})

    def __call__(self, request):
        self.requests.append(request)
        return self.answer(request)


class FakeMessage:
    def __init__(self, event: dict | bytes, routing_key: str | None = None):
        self.body = event if isinstance(event, bytes) else json.dumps(event).encode()
        self.routing_key = routing_key if routing_key is not None else (
            event.get("type") if isinstance(event, dict) else None)
        self.message_id = event.get("eventId") if isinstance(event, dict) else None
        self.result: str | None = None

    async def ack(self):
        assert self.result is None, "message settled twice"
        self.result = "ack"

    async def nack(self, requeue=True):
        assert self.result is None, "message settled twice"
        assert requeue is False, "never nack with requeue=True"
        self.result = "nack"


def envelope(type_: str, payload: dict, **changes) -> dict:
    event = {
        "eventId": str(uuid.uuid4()),
        "type": type_,
        "version": 1,
        "occurredAt": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "requestId": str(uuid.uuid4()),
        "payload": payload,
    }
    return event | changes


def registered(first_name="Anna", email="anna.nowak@example.com"):
    return envelope("user.registered", {"userId": CUSTOMER, "email": email, "firstName": first_name})


def order_created():
    return envelope("order.created", {
        "orderId": ORDER, "userId": CUSTOMER,
        "items": [{"productId": "a0000000-0000-4000-8000-000000000001", "name": "Kubek ceramiczny",
                   "quantity": 2, "unitPrice": "19.99"}],
        "total": "54.97", "currency": "PLN", "shippingMethod": "COURIER", "shippingCost": "14.99",
        "shippingAddress": {"firstName": "Anna", "lastName": "Nowak", "street": "ul. Prosta 1/2",
                            "postalCode": "00-001", "city": "Warszawa", "countryCode": "PL"},
    })


def order_cancelled():
    return envelope("order.cancelled", {
        "orderId": ORDER, "userId": CUSTOMER,
        "items": [{"productId": "a0000000-0000-4000-8000-000000000001", "quantity": 2}]})


def shipment(status, tracking="PL1234567890"):
    return envelope("shipment.status_changed", {
        "shipmentId": "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b", "orderId": ORDER, "userId": CUSTOMER,
        "oldStatus": "PREPARING", "newStatus": status, "trackingNumber": tracking})


@pytest.fixture
def store():
    return FakeStore()


@pytest.fixture
def mailer():
    return FakeMailer()


@pytest.fixture
def user():
    return FakeUser()


@pytest.fixture
def consumer(store, mailer, user):
    """Consumer with fakes and no waiting between attempts. Tests call it inside asyncio.run()."""
    settings = Settings(consul_enabled=False, user_service_url="http://user")
    http = httpx.AsyncClient(transport=httpx.MockTransport(user))
    c = Consumer(settings, store, mailer, UserClient(http, Discovery(None, {USER_SERVICE: "http://user"})))
    c.retry_delays = (0, 0)
    c.record_delays = (0, 0)
    yield c
    asyncio.run(http.aclose())
