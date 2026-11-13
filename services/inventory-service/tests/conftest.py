import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

from app import db
from app.main import app
from app.models import Base

ADMIN = {"X-User-Id": "1", "X-User-Roles": "ADMIN"}
CUSTOMER = {"X-User-Id": "2", "X-User-Roles": "CUSTOMER"}
SERVICE = {"X-User-Roles": "SERVICE"}


@pytest.fixture
def engine():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    db.configure(engine)
    yield engine
    Base.metadata.drop_all(engine)
    engine.dispose()


@pytest.fixture
def client(engine):

    return TestClient(app)


@pytest.fixture
def stocked(client):
    """Produkt 10 ze stanem 10 sztuk."""
    resp = client.put("/inventory/10", json={"quantity": 10}, headers=ADMIN)
    assert resp.status_code == 200
    return 10
