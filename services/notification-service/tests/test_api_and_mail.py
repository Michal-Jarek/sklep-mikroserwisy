"""HTTP API of the service (health, history) and the e-mail format."""

import uuid
from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from app.config import Settings
from app.mailer import build_message, render
from app.main import create_app

from .conftest import CUSTOMER, FakeMailer, FakeStore


def client_for(store):
    settings = Settings(consul_enabled=False, instance_id="notification-service-test")
    return TestClient(create_app(settings, store=store, mailer=FakeMailer()))


def test_health_and_headers():
    store = FakeStore()
    with client_for(store) as client:
        response = client.get("/health/live", headers={"X-Request-Id": "n-1"})
        assert response.json() == {"status": "UP"}
        assert response.headers["X-Request-Id"] == "n-1"
        assert response.headers["X-Instance-Id"] == "notification-service-test"
        assert client.get("/health/ready").status_code == 200
        store.ready = False
        response = client.get("/health/ready")
        assert response.status_code == 503 and response.json()["error"] == "SERVICE_UNAVAILABLE"
        assert client.get("/health/live").status_code == 200


def test_history_requires_login_and_shows_only_own_entries():
    store = FakeStore()
    now = datetime.now(UTC)
    other = str(uuid.uuid4())
    store.entries = [
        {"_id": "1", "eventId": "e1", "type": "user.registered", "userId": CUSTOMER, "subject": "Witamy w sklepie",
         "sentAt": now - timedelta(days=1), "requestId": "r"},
        {"_id": "2", "eventId": "e2", "type": "order.created", "userId": CUSTOMER,
         "subject": "Potwierdzenie zamówienia", "sentAt": now, "requestId": "r"},
        {"_id": "3", "eventId": "e3", "type": "user.registered", "userId": other, "subject": "Witamy w sklepie",
         "sentAt": now, "requestId": "r"},
    ]
    with client_for(store) as client:
        response = client.get("/notifications/me")
        assert response.status_code == 401 and response.json()["error"] == "UNAUTHORIZED"
        body = client.get("/notifications/me", headers={"X-User-Id": CUSTOMER, "X-User-Roles": "CUSTOMER"}).json()
        assert body["total"] == 2 and [i["id"] for i in body["items"]] == ["2", "1"]
        assert body["items"][0]["sentAt"].endswith("Z")
        assert set(body["items"][0]) == {"id", "type", "subject", "sentAt"}
        assert client.get("/notifications/me", headers={"X-User-Id": "x"}).status_code == 400
        assert client.get("/notifications/me?size=101", headers={"X-User-Id": CUSTOMER}).status_code == 400
        assert client.get("/notifications/me/", headers={"X-User-Id": CUSTOMER}).status_code == 404


def test_email_message_has_text_and_html():
    mail = render("welcome", "anna@example.com", first_name="Anna")
    message = build_message(mail, "Sklep <sklep@sklep.local>")
    assert message["To"] == "anna@example.com" and message["Subject"] == "Witamy w sklepie"
    assert message.is_multipart()
    assert [part.get_content_type() for part in message.iter_parts()] == ["text/plain", "text/html"]
