import mongomock
import pytest
from fastapi.testclient import TestClient

from app import db
from app.db import get_reviews
from app.main import app
from app.order_client import OrderServiceUnavailable, get_order_client

U1 = "5c9d1a7e-3b2f-4e8a-b6d4-1f0e9a8c7b65"
U2 = "6e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b"
U_ADMIN = "0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e"

CUSTOMER = {"X-User-Id": U1, "X-User-Roles": "CUSTOMER"}
OTHER = {"X-User-Id": U2, "X-User-Roles": "CUSTOMER"}
ADMIN = {"X-User-Id": U_ADMIN, "X-User-Roles": "ADMIN"}

# identyfikatory produktów to UUID zapisany tekstem
P1 = "3f0c9b1e-6a52-4a8e-9c1f-0b2f7e1d5a77"
P2 = "7d2b4c10-1e55-4f0a-8a31-5c6e9b0d2f44"
P_NOT_BOUGHT = "99999999-9999-4999-8999-999999999999"
P_ORDER_DOWN = "88888888-8888-4888-8888-888888888888"


class FakeOrderClient:
    """Podmienia Order Service: kupione są wszystkie produkty poza P_NOT_BOUGHT; P_ORDER_DOWN = Order nie działa."""

    def __init__(self):
        self.calls = []

    def has_purchased(self, user_id, product_id, headers):
        self.calls.append((user_id, product_id, headers))
        if product_id == P_ORDER_DOWN:
            raise OrderServiceUnavailable("down")
        return product_id != P_NOT_BOUGHT


@pytest.fixture
def reviews():
    collection = mongomock.MongoClient().db[db.COLLECTION]
    db.ensure_indexes(collection)
    return collection


@pytest.fixture
def orders():
    return FakeOrderClient()


@pytest.fixture
def client(reviews, orders):
    app.dependency_overrides[get_reviews] = lambda: reviews
    app.dependency_overrides[get_order_client] = lambda: orders
    yield TestClient(app)  # bez "with" - bez lifespan (Mongo, Consul)
    app.dependency_overrides.clear()


def add_review(client, product_id=P1, rating=5, comment="Super", headers=CUSTOMER):
    return client.post(
        "/reviews", json={"productId": product_id, "rating": rating, "comment": comment}, headers=headers
    )
