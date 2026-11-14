import asyncio
import json
import logging
from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID, uuid4

import aio_pika
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from .models import Outbox, Processed, Shipment, change_status

log = logging.getLogger("shipping.events")
Text = Annotated[str, Field(min_length=1, max_length=200)]


class Address(BaseModel):
    firstName: Text
    lastName: Text
    street: Text
    city: Text
    postalCode: Text
    countryCode: Annotated[str, Field(pattern="^[A-Z]{2}$")]


class Creation(BaseModel):
    orderId: UUID
    userId: UUID
    shippingMethod: Literal["COURIER", "PARCEL_LOCKER", "PICKUP"]
    shippingCost: Annotated[str, Field(pattern=r"^[0-9]+\.[0-9]{2}$")]
    currency: Literal["PLN"]
    shippingAddress: Address


def handle(factory, body, key):
    event = json.loads(body)
    if not isinstance(event, dict) or any(not isinstance(event.get(k), str)
            for k in ("type", "eventId", "requestId", "occurredAt")):
        raise ValueError("invalid envelope")
    event_id = str(UUID(event["eventId"]))
    if (type(event.get("version")) is not int or event["version"] != 1
            or event["type"] != key or not isinstance(event.get("payload"), dict)):
        raise ValueError("invalid envelope")
    if key not in ("order.created", "order.cancelled"):
        return
    payload = event["payload"]
    order_id = str(UUID(payload["orderId"]))
    user_id = str(UUID(payload["userId"]))
    creation = Creation.model_validate(payload) if key == "order.created" else None

    with factory.begin() as db:
        insert = sqlite_insert if db.get_bind().dialect.name == "sqlite" else pg_insert
        seen = db.execute(insert(Processed).values(id=event_id).on_conflict_do_nothing(index_elements=["id"]))
        if not seen.rowcount:
            return
        # Creating a row before locking also serializes creation vs. cancellation of a new order.
        db.execute(insert(Shipment).values(order_id=order_id, user_id=user_id, status="NEW")
                   .on_conflict_do_nothing(index_elements=["order_id"]))
        shipment = db.scalar(select(Shipment).where(Shipment.order_id == order_id).with_for_update())
        if shipment.user_id != user_id:
            raise ValueError("inconsistent userId for order")
        if creation and shipment.status == "NEW":
            shipment.id = str(uuid4())
            shipment.destination = creation.shippingAddress.model_dump()
            shipment.method = creation.shippingMethod
            shipment.cost = creation.shippingCost
            shipment.currency = creation.currency
            shipment.status = None  # First public state has no predecessor.
            change_status(db, shipment, "PREPARING", event["requestId"])
        elif not creation:
            if shipment.status == "NEW":
                shipment.status = "CANCELLED"
            elif shipment.status == "PREPARING":
                change_status(db, shipment, "CANCELLED", event["requestId"])
async def receive(message, factory):
    for delay in (0, 5, 30):
        await asyncio.sleep(delay)
        try:
            await asyncio.to_thread(handle, factory, message.body, message.routing_key)
        except (ValueError, KeyError, TypeError, AttributeError):
            break
        except Exception:
            log.warning("Błąd zapisu zdarzenia")
            continue
        await message.ack()
        return
    await message.nack(requeue=False)


async def broker(settings, factory):
    while True:
        try:
            async with await aio_pika.connect(host=settings.rabbitmq_host, login="shipping-service",
                    password=settings.shipping_rabbitmq_password, timeout=2) as connection:
                channel = await connection.channel(publisher_confirms=True, on_return_raises=True)
                await channel.set_qos(prefetch_count=10)
                queue = await channel.get_queue("shipping.q", ensure=True)
                exchange = await channel.get_exchange("shop.events", ensure=False)
                async def consume(message):
                    await receive(message, factory)
                await queue.consume(consume)
                while not connection.is_closed:
                    with factory.begin() as db:
                        row = db.scalar(select(Outbox).order_by(Outbox.seq).limit(1)
                                        .with_for_update(skip_locked=True))
                        if row:
                            event = row.envelope
                            await exchange.publish(aio_pika.Message(json.dumps(event).encode(),
                                content_type="application/json", message_id=event["eventId"],
                                timestamp=datetime.fromisoformat(event["occurredAt"]), type=event["type"], app_id="shipping-service",
                                correlation_id=event["requestId"], delivery_mode=aio_pika.DeliveryMode.PERSISTENT),
                                routing_key=event["type"], mandatory=True, timeout=2)
                            db.delete(row)
                    await asyncio.sleep(0 if row else 0.5)
        except Exception:
            log.warning("RabbitMQ lub outbox niedostępny; ponowienie za 2 s")
            await asyncio.sleep(2)



