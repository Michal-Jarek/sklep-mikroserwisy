"""Consumer of notification.q (docs/events.md, "Jak odbierać"; D19).

- The queue is opened passively: exchange, queue, bindings and DLQ belong to the platform.
- prefetch 10, manual ack after the effect; never nack with requeue=True.
- A message that can never be processed (bad JSON, wrong envelope, type different from the routing
  key, unknown version, bad payload) -> nack(requeue=False) at once -> notification.dlq.
- A temporary error (User, SMTP or MongoDB down): 3 attempts, 5 s then 30 s apart plus a random
  extra of up to 50 %, then the DLQ. A permanent refusal of User (4xx other than 404, 408, 429, or an
  answer outside the contract): the DLQ at once, no retries.
- Idempotency: the eventId is checked before sending and saved with a unique index after the e-mail
  went out ("e-mail first, then eventId": a rare second e-mail rather than a lost one).

Which e-mails:
| type                    | e-mail                                    | address from          |
| user.registered         | welcome                                   | the event payload     |
| order.created           | order confirmation                        | User (GET /users/{id})|
| order.cancelled         | cancellation                              | User                  |
| shipment.status_changed | only SHIPPED and DELIVERED; others: ack   | User                  |
"""

import asyncio
import json
import random
import socket
import uuid
from collections.abc import Awaitable, Callable
from typing import Annotated, Literal

import aio_pika
from aio_pika.abc import AbstractIncomingMessage
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError

from .config import SERVICE_NAME, Settings
from .logs import logger, request_id_var, user_id_var
from .mailer import SHIPPING_METHODS, Mail, render
from .store import Store, new_entry
from .users import PermanentError, UserClient
from .web import REQUEST_ID_PATTERN

QUEUE = "notification.q"
PREFETCH = 10
MAX_CONNECT_DELAY = 30
# Each retry delay gets a random extra of up to 50 %: events that failed together must not come back
# together, because a half-open circuit breaker lets only one call through (docs/events.md, rule 4).
RETRY_SPREAD = 0.5
# Seconds between checks that the queue still exists. A deleted queue cancels the consumer on the
# broker side without any error in the client; the check ends the task instead (log + 503).
QUEUE_CHECK_SECONDS = 15
ENVELOPE_FIELDS = ("eventId", "type", "version", "occurredAt", "requestId", "payload")
TEXT_FIELDS = ("eventId", "type", "occurredAt", "requestId")

Money = Annotated[str, StringConstraints(pattern=r"^[0-9]{1,8}\.[0-9]{2}$")]
Text = Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]


class Payload(BaseModel):
    # Unknown payload fields are ignored: a sender may add an optional field without a new version.
    model_config = ConfigDict(extra="ignore")


class UserRegistered(Payload):
    userId: uuid.UUID
    email: Annotated[str, StringConstraints(
        strip_whitespace=True, min_length=3, max_length=254, pattern=r"^[^@\s]+@[^@\s]+$")]
    firstName: Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)]


# Only the payload fields the e-mails use are required (docs/events.md, "Pola, których używają
# odbiorcy"); a new required field means a change in that table too.

class OrderLine(Payload):
    name: Text
    quantity: Annotated[int, Field(ge=1)]
    unitPrice: Money


class OrderCreated(Payload):
    orderId: uuid.UUID
    userId: uuid.UUID
    items: Annotated[list[OrderLine], Field(min_length=1)]
    total: Money
    currency: Literal["PLN"]
    shippingMethod: Text
    shippingCost: Money


class CancelledLine(Payload):
    quantity: Annotated[int, Field(ge=1)]


class OrderCancelled(Payload):
    orderId: uuid.UUID
    userId: uuid.UUID
    items: list[CancelledLine]


class ShipmentStatusChanged(Payload):
    orderId: uuid.UUID
    userId: uuid.UUID
    newStatus: Literal["PREPARING", "SHIPPED", "IN_TRANSIT", "DELIVERED", "CANCELLED"]
    # null before the parcel is handed over (open question of contract v1)
    trackingNumber: Text | None = None


# Event types handled by this service: supported version and the payload model.
HANDLED: dict[str, tuple[int, type[Payload]]] = {
    "user.registered": (1, UserRegistered),
    "order.created": (1, OrderCreated),
    "order.cancelled": (1, OrderCancelled),
    "shipment.status_changed": (1, ShipmentStatusChanged),
}


class InvalidEvent(Exception):
    """The message can never be processed: trying again will not help."""


def parse_event(body: bytes, routing_key: str | None) -> tuple[dict, Payload | None]:
    try:
        event = json.loads(body)
    except ValueError as exc:
        raise InvalidEvent("body is not valid JSON") from exc
    if not isinstance(event, dict) or any(field not in event for field in ENVELOPE_FIELDS):
        raise InvalidEvent("missing envelope fields")
    if not all(isinstance(event[field], str) for field in TEXT_FIELDS):
        raise InvalidEvent("envelope fields of a wrong type")
    if type(event["version"]) is not int:  # bool is not accepted either
        raise InvalidEvent("version is not an integer")
    if not isinstance(event["payload"], dict):
        raise InvalidEvent("payload is not an object")
    try:
        if str(uuid.UUID(event["eventId"])) != event["eventId"].lower():
            raise ValueError
    except ValueError:
        raise InvalidEvent("eventId is not a UUID") from None
    if not REQUEST_ID_PATTERN.fullmatch(event["requestId"]):
        # It goes into the X-Request-Id header to User: a character outside the rule (e.g. non-ASCII)
        # would fail every call and open the circuit breaker for all customers. A new id, like the Gateway.
        event["requestId"] = str(uuid.uuid4())
    # RabbitMQ checks the sender's permissions against the routing key, not the body:
    # only the routing key tells who could have sent the event.
    if event["type"] != routing_key:
        raise InvalidEvent("type does not match the routing key")
    if event["type"] not in HANDLED:
        return event, None
    version, model = HANDLED[event["type"]]
    if event["version"] != version:
        raise InvalidEvent(f"unsupported version {event['version']}")
    try:
        payload = model.model_validate(event["payload"])
    except ValidationError as exc:
        # Only the field names, never the values (personal data).
        fields = sorted({".".join(map(str, error["loc"])) for error in exc.errors()})
        raise InvalidEvent(f"invalid payload fields: {', '.join(fields)}") from None
    return event, payload


def short_number(order_id: uuid.UUID) -> str:
    """Order number shown to the customer: the first 8 characters of the UUID, in capitals."""
    return str(order_id)[:8].upper()


class Consumer:
    # Seconds before attempt 2 and before attempt 3 (docs/events.md, rule 4). Tests set them to 0.
    retry_delays: tuple[float, ...] = (5, 30)
    # After the e-mail went out, saving the eventId is tried this many extra times, never with a resend.
    record_delays: tuple[float, ...] = (1, 5)
    queue_check_seconds: float = QUEUE_CHECK_SECONDS

    def __init__(self, settings: Settings, store: Store, mailer, users: UserClient):
        self.settings = settings
        self.store = store
        self.mailer = mailer
        self.users = users

    # ----- one message -----

    async def on_message(self, message: AbstractIncomingMessage) -> None:
        request_id_var.set(None)
        user_id_var.set(None)
        try:
            event, payload = parse_event(message.body, message.routing_key)
        except Exception as exc:
            # The message itself is wrong: straight to the DLQ. No message stays without ack or nack.
            why = str(exc) if isinstance(exc, InvalidEvent) else type(exc).__name__
            logger.error("Invalid event, moved to the DLQ",
                         extra={"fields": {"messageId": message.message_id, "routingKey": message.routing_key,
                                           "reason": why}})
            await message.nack(requeue=False)
            return

        request_id_var.set(event["requestId"])
        user_id_var.set(str(getattr(payload, "userId", "")) or None)
        fields = {"eventId": event["eventId"], "type": event["type"]}
        if payload is None:
            await message.ack()  # a type this service does not need
            return

        attempts = len(self.retry_delays) + 1
        for attempt in range(1, attempts + 1):
            try:
                if await self.store.is_processed(event["eventId"]):
                    logger.info("Duplicate event, skipped", extra={"fields": fields})
                    await message.ack()
                    return
                mail = await self.prepare(event, payload)
                if mail is None:
                    await message.ack()
                    return
                await self.mailer.send(mail)
                break
            except PermanentError as exc:
                logger.error("Event refused for good, moved to the DLQ",
                             extra={"fields": {**fields, "reason": str(exc)}})
                await message.nack(requeue=False)
                return
            except Exception as exc:
                # Only the class of the exception: its message may contain personal data.
                why = type(exc).__name__
                if attempt == attempts:
                    logger.error("Event failed 3 times, moved to the DLQ", extra={"fields": {**fields, "reason": why}})
                    await message.nack(requeue=False)  # never requeue=True
                    return
                logger.warning("Event failed, will retry",
                               extra={"fields": {**fields, "attempt": attempt, "reason": why}})
                await asyncio.sleep(self.retry_delays[attempt - 1] * random.uniform(1, 1 + RETRY_SPREAD))

        await self.remember(event, payload, mail)
        logger.info("E-mail sent", extra={"fields": {**fields, "subject": mail.subject}})
        await message.ack()

    async def remember(self, event: dict, payload: Payload, mail: Mail) -> None:
        """Save the eventId after the e-mail went out. Never resend because of a database error."""
        entry = new_entry(event, str(payload.userId), mail.subject)
        for attempt in range(len(self.record_delays) + 1):
            try:
                if not await self.store.record(entry):
                    logger.info("Event already recorded by another instance",
                                extra={"fields": {"eventId": event["eventId"]}})
                return
            except Exception as exc:
                if attempt == len(self.record_delays):
                    logger.error("E-mail sent but the eventId was not saved",
                                 extra={"fields": {"eventId": event["eventId"], "reason": type(exc).__name__}})
                    return
                await asyncio.sleep(self.record_delays[attempt])

    async def prepare(self, event: dict, payload: Payload) -> Mail | None:
        """The e-mail for this event, or None when no e-mail is needed (then ack without action)."""
        match payload:
            case UserRegistered():
                return render("welcome", payload.email, first_name=payload.firstName)
            case ShipmentStatusChanged() if payload.newStatus not in ("SHIPPED", "DELIVERED"):
                return None  # other statuses: no e-mail, and no call to User
        recipient = await self.users.recipient(str(payload.userId), event["requestId"])
        if recipient is None:
            logger.warning("No profile in User, no e-mail sent", extra={"fields": {"eventId": event["eventId"]}})
            return None
        common = {"first_name": recipient.first_name, "order_number": short_number(payload.orderId)}
        match payload:
            case OrderCreated():
                return render(
                    "order_created", recipient.email, **common,
                    items=[line.model_dump() for line in payload.items],
                    currency=payload.currency, total=payload.total, shipping_cost=payload.shippingCost,
                    shipping_method=SHIPPING_METHODS.get(payload.shippingMethod, payload.shippingMethod),
                )
            case OrderCancelled():
                return render("order_cancelled", recipient.email, **common,
                              item_count=sum(line.quantity for line in payload.items))
            case ShipmentStatusChanged() if payload.newStatus == "SHIPPED":
                return render("shipment_shipped", recipient.email, **common, tracking_number=payload.trackingNumber)
            case ShipmentStatusChanged():
                return render("shipment_delivered", recipient.email, **common)
        return None

    # ----- connection -----

    async def wait_for(self, what: str, step: Callable[[], Awaitable[object]]) -> object:
        """Runs step() until it works: 1 s, 2 s, 4 s ... up to 30 s apart, one warning per try."""
        delay = 1
        while True:
            try:
                return await step()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # Only the class: never connection settings with the password.
                logger.warning(f"{what} unavailable, retrying",
                               extra={"fields": {"reason": type(exc).__name__, "retryIn": delay}})
                await asyncio.sleep(delay)
                delay = min(delay * 2, MAX_CONNECT_DELAY)

    async def run(self) -> None:
        """Background task of the service. Ends on a bug, missing access to the queue or a deleted
        queue, which makes /health/ready 503 (the reason is logged by main.py). A broker outage
        does not end it: connect_robust reconnects."""
        await self.wait_for("MongoDB", self.store.ensure_indexes)
        settings = self.settings
        connection = await self.wait_for("RabbitMQ", lambda: aio_pika.connect_robust(
            host=settings.rabbitmq_host,
            port=settings.rabbitmq_port,
            login=settings.rabbitmq_user,
            password=settings.rabbitmq_password,
            client_properties={"connection_name": f"{SERVICE_NAME}-{socket.gethostname()}"},
        ))
        async with connection:
            channel = await connection.channel()
            await channel.set_qos(prefetch_count=PREFETCH)
            # Passive open: the queue, its bindings and its DLQ are created by the platform.
            queue = await channel.get_queue(QUEUE, ensure=True)
            # Manual acknowledgement: every message ends with ack() or nack(requeue=False).
            await queue.consume(self.on_message)
            logger.info("Consumer started", extra={"fields": {"queue": QUEUE}})
            # Until the task is cancelled (shutdown). A deleted queue cancels the consumer on the broker
            # without any error here, so the queue is checked from time to time (docs/events.md).
            while True:
                await asyncio.sleep(self.queue_check_seconds)
                try:
                    await channel.get_queue(QUEUE, ensure=True)
                except aio_pika.exceptions.ChannelNotFoundEntity:
                    raise  # the queue is gone: end the task
                except (aio_pika.exceptions.AMQPError, ConnectionError, asyncio.TimeoutError) as exc:
                    # A broker outage: connect_robust reconnects by itself, the next check tries again.
                    logger.warning("Queue check skipped", extra={"fields": {"reason": type(exc).__name__}})
