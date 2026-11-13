import mongomock
import pytest
from fastapi.testclient import TestClient

from app import db
from app.db import get_reviews
from app.main import app
from app.order_client import OrderServiceUnavailable, get_order_client

CUSTOMER = {"X-User-Id": "u1", "X-User-Roles": "CUSTOMER"}
OTHER = {"X-User-Id": "u2", "X-User-Roles": "CUSTOMER"}
ADMIN = {"X-User-Id": "admin", "X-User-Roles": "ADMIN"}


class FakeOrderClient:
    """Podmienia Order Service: kupione są wszystkie produkty poza 999; 888 = Order nie działa."""

    def __init__(self):
        self.calls = []

    def has_purchased(self, user_id, product_id, headers=None):
        self.calls.append((user_id, product_id, headers))
        if product_id == 888:
            raise OrderServiceUnavailable("down")
        return product_id != 999


@pytest.fixture
def reviews():
    collection = mongomock.MongoClient().db.reviews
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


def add_review(client, product_id=1, rating=5, comment="Super", headers=CUSTOMER):
    return client.post(
        "/reviews", json={"productId": product_id, "rating": rating, "comment": comment}, headers=headers
    )
