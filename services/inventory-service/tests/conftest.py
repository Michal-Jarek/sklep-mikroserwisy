import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

from app import db
from app.main import app
from app.models import Base

ADMIN = {"X-User-Id": "0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e", "X-User-Roles": "ADMIN"}
CUSTOMER = {"X-User-Id": "5c9d1a7e-3b2f-4e8a-b6d4-1f0e9a8c7b65", "X-User-Roles": "CUSTOMER"}
SERVICE = {"X-User-Roles": "SERVICE"}

# identyfikatory produktów to UUID zapisany tekstem
P1 = "3f0c9b1e-6a52-4a8e-9c1f-0b2f7e1d5a77"
P2 = "7d2b4c10-1e55-4f0a-8a31-5c6e9b0d2f44"
P_UNKNOWN = "99999999-9999-4999-8999-999999999999"


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
    # bez "with" - nie uruchamiamy lifespan (Consul, RabbitMQ, Postgres)
    return TestClient(app)


@pytest.fixture
def stocked(client):
    """Produkt P1 ze stanem 10 sztuk."""
    resp = client.put(f"/inventory/{P1}", json={"quantity": 10}, headers=ADMIN)
    assert resp.status_code == 200
    return P1
