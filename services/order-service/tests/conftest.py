import asyncio
import json
import logging
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.config import Settings
from app.logging_config import JsonFormatter
from app.main import create_app
from app.models import Order, Outbox

BODY = {"shippingAddress": dict(firstName="Jan", lastName="Kot", street="Polna 1", postalCode="00-001",
                                city="Warszawa", countryCode="PL"),
        "shippingMethod": "COURIER", "payment": {"cardNumber": "4111111111111111"}}


async def hanging_connect(request: httpx.Request) -> httpx.Response:
    """An address nobody answers at (a container stopped a moment ago, still listed). Like httpcore, the connect
    phase ends after its own timeout taken from the request, as ConnectTimeout; without one it hangs on."""
    connect = request.extensions["timeout"].get("connect")
    await asyncio.sleep(3600 if connect is None else connect)
    raise httpx.ConnectTimeout("mock: connect timed out", request=request)


class Dependencies:
    """Cart, Product, Inventory and Shipping behind httpx.MockTransport.

    rules["inventory:POST"] = {"status": 503, "delay": 0.3, "error": httpx.ConnectError, "json": {...}}
    rules["inventory:POST"] = {"connect_hangs": True}  (hanging_connect)
    """

    def __init__(self, customer: str, product: str):
        self.customer = customer
        self.product = product
        self.calls: list[httpx.Request] = []
        self.rules: dict[str, dict] = {}

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        key = f"{request.url.host}:{request.method}"
        rule = self.rules.get(key, {})
        if rule.get("connect_hangs"):
            return await hanging_connect(request)
        if rule.get("delay"):
            await asyncio.sleep(rule["delay"])
        if rule.get("error"):
            raise rule["error"]("mock", request=request)
        if "status" in rule:
            return httpx.Response(rule["status"], json=rule.get("json", {"error": "MOCK"}))
        return self.default(request)

    def default(self, request: httpx.Request) -> httpx.Response:
        path, user = request.url.path, request.headers.get("X-User-Id")
        if path == "/cart" and request.method == "GET":
            return httpx.Response(200, json={"userId": user, "items": [{"productId": self.product, "quantity": 2}]})
        if path.startswith("/products/"):
            return httpx.Response(200, json={"id": path.rsplit("/", 1)[1], "name": "Kubek", "price": "19.99",
                                             "currency": "PLN"})
        if path.startswith("/shipping/methods/"):
            return httpx.Response(200, json={"code": path.rsplit("/", 1)[1], "price": "14.99", "currency": "PLN"})
        if path == "/inventory/reservations":
            return httpx.Response(201, json={"orderId": json.loads(request.content)["orderId"], "status": "ACTIVE"})
        if path == "/shipments/cancel":
            return httpx.Response(200, json={"orderId": json.loads(request.content)["orderId"], "shipmentId": None,
                                             "status": "CANCELLED"})
        if request.method == "DELETE":
            return httpx.Response(204)
        return httpx.Response(404, json={"error": "NOT_FOUND"})

    def made(self, host: str, method: str) -> list[httpx.Request]:
        return [c for c in self.calls if c.url.host == host and c.method == method]


def settings(tmp_path) -> Settings:
    return Settings(db_url=f"sqlite:///{tmp_path}/test.db", consul_enabled=False, broker_enabled=False,
                    cart_service_url="http://cart", inventory_service_url="http://inventory",
                    shipping_service_url="http://shipping", product_service_url="http://product")


@pytest.fixture
def deps():
    return Dependencies(str(uuid4()), str(uuid4()))


@pytest.fixture
def client(tmp_path, deps):
    app = create_app(settings(tmp_path))
    with TestClient(app) as test_client:
        app.state.peers.client = httpx.AsyncClient(transport=httpx.MockTransport(deps))
        yield test_client


@pytest.fixture
def headers(deps):
    return {"X-User-Id": deps.customer, "X-User-Roles": "CUSTOMER", "Idempotency-Key": str(uuid4())}


@pytest.fixture
def body():
    return json.loads(json.dumps(BODY))


def outbox(client) -> list[dict]:
    with client.app.state.session_factory() as session:
        return [row.envelope for row in session.scalars(select(Outbox).order_by(Outbox.seq))]


def orders_in_db(client) -> list[Order]:
    with client.app.state.session_factory() as session:
        return list(session.scalars(select(Order)))


@pytest.fixture
def json_logs(caplog):
    """Lines of the consumer logger formatted when written (requestId and userId come from context variables)."""
    lines: list[dict] = []
    formatter = JsonFormatter("order-service")

    class Collect(logging.Handler):
        def emit(self, record):
            lines.append(json.loads(formatter.format(record)))

    caplog.set_level(logging.INFO, logger="app.consumer")
    logger, handler = logging.getLogger("app.consumer"), Collect()
    logger.addHandler(handler)
    yield lines
    logger.removeHandler(handler)
