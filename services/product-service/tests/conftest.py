"""Tests run without Docker: a temporary SQLite database with the migrations applied, no Consul,
and fake Review and Inventory (httpx.MockTransport). With TEST_DATABASE_URL (e.g.
postgresql+psycopg://user:password@127.0.0.1:5432/test_db) they run on PostgreSQL instead."""

import os
from pathlib import Path

import httpx
import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

ADMIN = {"X-User-Id": "b0000000-0000-4000-8000-000000000002", "X-User-Roles": "ADMIN"}
CUSTOMER = {"X-User-Id": "b0000000-0000-4000-8000-000000000001", "X-User-Roles": "CUSTOMER"}
KUBEK = "a0000000-0000-4000-8000-000000000001"
KITCHEN = "c0000000-0000-4000-8000-000000000001"
BOOKS = "c0000000-0000-4000-8000-000000000002"


@pytest.fixture
def database_url(tmp_path):
    url = os.getenv("TEST_DATABASE_URL") or f"sqlite:///{tmp_path / 'products.db'}"
    cfg = Config(str(Path(__file__).parents[1] / "alembic.ini"))
    cfg.attributes["database_url"] = url
    if os.getenv("TEST_DATABASE_URL"):
        command.downgrade(cfg, "base")  # a clean test database for every test
    command.upgrade(cfg, "head")
    yield url
    if os.getenv("TEST_DATABASE_URL"):
        command.downgrade(cfg, "base")


class FakeServices:
    """Answers of Review and Inventory; a test changes them. Records the received requests."""

    def __init__(self):
        self.requests: list[httpx.Request] = []
        self.review = lambda request: httpx.Response(200, json={
            "productId": request.url.path.rsplit("/", 1)[-1], "averageRating": 4.46, "reviewCount": 12})
        self.inventory = lambda request: httpx.Response(200, json={
            "productId": request.url.path.rsplit("/", 1)[-1], "quantity": 12, "reserved": 2,
            "available": 10, "inStock": True})

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.host == "review":
            return self.review(request)
        return self.inventory(request)


@pytest.fixture
def services():
    return FakeServices()


@pytest.fixture
def client(database_url, services):
    settings = Settings(
        db_url=database_url,
        consul_enabled=False,
        review_service_url="http://review",
        inventory_service_url="http://inventory",
        instance_id="product-service-test",
    )
    app = create_app(settings, transport=httpx.MockTransport(services))
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def new_product():
    return {
        "name": "Kubek termiczny",
        "description": "Kubek 400 ml.",
        "price": "39.99",
        "currency": "PLN",
        "categoryId": KITCHEN,
        "imageUrl": "https://img.example.com/kubek.jpg",
    }
