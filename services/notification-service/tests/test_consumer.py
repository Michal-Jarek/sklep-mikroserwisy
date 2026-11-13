"""Consumer rules of docs/events.md (D19) and the e-mails of Notification."""

import asyncio

import httpx

from .conftest import CUSTOMER, FakeMessage, envelope, order_cancelled, order_created, registered, shipment


def deliver(consumer, message):
    asyncio.run(consumer.on_message(message))
    return message


# ----- e-mails -----

def test_welcome_email_from_registration(consumer, mailer, store, user):
    event = registered()
    message = deliver(consumer, FakeMessage(event))
    assert message.result == "ack"
    [mail] = mailer.sent
    assert mail.to == "anna.nowak@example.com" and mail.subject == "Witamy w sklepie"
    assert "Cześć Anna!" in mail.text and "Cześć Anna!" in mail.html
    assert user.requests == []  # the address is in the event, no call to User
    [entry] = store.entries
    assert entry["eventId"] == event["eventId"] and entry["userId"] == CUSTOMER
    assert "email" not in entry  # no address in the log


def test_name_from_the_customer_is_escaped_in_html(consumer, mailer):
    deliver(consumer, FakeMessage(registered(first_name='<a href="https://zly.example">Rabat</a>')))
    [mail] = mailer.sent
    assert "<a href" not in mail.html and "&lt;a href=" in mail.html


def test_order_confirmation_uses_user_service(consumer, mailer, user):
    event = order_created()
    assert deliver(consumer, FakeMessage(event)).result == "ack"
    [mail] = mailer.sent
    assert mail.to == "anna.nowak@example.com" and mail.subject == "Potwierdzenie zamówienia"
    assert "5D7E9F1A" in mail.text and "Kubek ceramiczny x 2" in mail.text
    assert "54.97 PLN" in mail.text and "kurier" in mail.text
    [request] = user.requests
    assert request.url.path == f"/users/{CUSTOMER}"
    # D11 / events.md rule 9: background work sends SERVICE, userId and requestId of the event
    assert request.headers["X-User-Roles"] == "SERVICE"
    assert request.headers["X-User-Id"] == CUSTOMER
    assert request.headers["X-Request-Id"] == event["requestId"]


def test_order_cancelled_email(consumer, mailer):
    assert deliver(consumer, FakeMessage(order_cancelled())).result == "ack"
    assert mailer.sent[0].subject == "Zamówienie anulowane" and "(2 szt.)" in mailer.sent[0].text


def test_shipment_shipped_and_delivered(consumer, mailer):
    deliver(consumer, FakeMessage(shipment("SHIPPED")))
    deliver(consumer, FakeMessage(shipment("DELIVERED")))
    assert [m.subject for m in mailer.sent] == ["Twoja paczka jest w drodze", "Paczka dostarczona"]
    assert "PL1234567890" in mailer.sent[0].text


def test_shipment_without_tracking_number(consumer, mailer):
    assert deliver(consumer, FakeMessage(shipment("SHIPPED", tracking=None))).result == "ack"
    assert "Numer przesyłki" not in mailer.sent[0].text


def test_other_shipment_statuses_need_no_email(consumer, mailer, user, store):
    for status in ("PREPARING", "IN_TRANSIT", "CANCELLED"):
        assert deliver(consumer, FakeMessage(shipment(status))).result == "ack"
    assert mailer.sent == [] and user.requests == [] and store.entries == []


def test_unknown_profile_in_user_gives_no_email(consumer, mailer, user):
    user.answer = lambda request: httpx.Response(404, json={"status": 404, "error": "NOT_FOUND"})
    assert deliver(consumer, FakeMessage(order_created())).result == "ack"
    assert mailer.sent == []


def test_unknown_event_type_is_acked(consumer, mailer):
    event = envelope("product.updated", {"anything": 1}, version=7)
    assert deliver(consumer, FakeMessage(event)).result == "ack"
    assert mailer.sent == []


# ----- idempotency -----

def test_duplicate_event_sends_one_email(consumer, mailer, store):
    event = registered()
    deliver(consumer, FakeMessage(event))
    assert deliver(consumer, FakeMessage(event)).result == "ack"
    assert len(mailer.sent) == 1 and len(store.entries) == 1


def test_event_recorded_meanwhile_by_another_instance(consumer, mailer, store):
    event = registered()

    async def is_processed(event_id):  # both instances checked before either recorded
        return False

    store.is_processed = is_processed
    deliver(consumer, FakeMessage(event))
    assert deliver(consumer, FakeMessage(event)).result == "ack"  # unique index: duplicate, not an error
    assert len(store.entries) == 1


def test_database_error_after_sending_does_not_resend(consumer, mailer, store):
    store.fail_records = 1
    assert deliver(consumer, FakeMessage(registered())).result == "ack"
    assert len(mailer.sent) == 1 and len(store.entries) == 1


# ----- temporary errors: 3 attempts, then the DLQ -----

def test_smtp_down_once_then_works(consumer, mailer):
    mailer.failures = 1
    assert deliver(consumer, FakeMessage(registered())).result == "ack"
    assert len(mailer.sent) == 1


def test_user_service_down_goes_to_dlq_after_3_attempts(consumer, mailer, user, store):
    user.answer = lambda request: httpx.Response(503, json={"status": 503, "error": "SERVICE_UNAVAILABLE"})
    message = deliver(consumer, FakeMessage(order_created()))
    assert message.result == "nack"
    assert mailer.sent == [] and store.entries == []
    # 3 attempts of the consumer, each with 3 tries of the HTTP call (D2: 503 is retried)
    assert len(user.requests) == 9


def test_database_down_goes_to_dlq(consumer, mailer, store):
    store.fail_reads = 3
    assert deliver(consumer, FakeMessage(registered())).result == "nack"
    assert mailer.sent == []


# ----- messages that can never be processed: straight to the DLQ -----

def test_invalid_messages_are_rejected_without_requeue(consumer, mailer):
    good = registered()
    wrong_payload = registered()
    wrong_payload["payload"]["email"] = "not-an-address"
    missing_field = registered()
    del missing_field["payload"]["firstName"]
    cases = [
        FakeMessage(b"{not json", "user.registered"),
        FakeMessage({k: v for k, v in good.items() if k != "requestId"}),
        FakeMessage(good | {"version": "1"}),
        FakeMessage(good | {"version": 2}),
        FakeMessage(good | {"payload": []}),
        FakeMessage(good, routing_key="order.created"),  # type in the body differs from the routing key
        FakeMessage(wrong_payload),
        FakeMessage(missing_field),
        FakeMessage(order_created() | {"payload": {"orderId": "123"}}),
    ]
    for message in cases:
        assert deliver(consumer, message).result == "nack", message.body
    assert mailer.sent == []
