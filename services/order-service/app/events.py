import asyncio
import json
import logging
from datetime import datetime
from uuid import UUID

import aio_pika
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from .models import Order, Outbox, Processed
from .orders import PAID_STATES, update_status

log = logging.getLogger("order.events")


def handle(factory, body, key):
    event = json.loads(body)
    if not isinstance(event, dict) or any(not isinstance(event.get(k), str)
            for k in ("type", "eventId", "requestId", "occurredAt")):
        raise ValueError("invalid envelope")
    event_id = str(UUID(event["eventId"]))
    if (type(event.get("version")) is not int or event["version"] != 1
            or key != event["type"] or not isinstance(event.get("payload"), dict)):
        raise ValueError("invalid envelope")
    if key != "shipment.status_changed":
        return
    data = event["payload"]
    status = data["newStatus"]
    if status not in ("PREPARING", "IN_TRANSIT", "SHIPPED", "DELIVERED", "CANCELLED"):
        raise ValueError("invalid shipment status")
    order_id = str(UUID(data["orderId"]))
    user_id = str(UUID(data["userId"]))
    with factory.begin() as db:
        insert = sqlite_insert if db.get_bind().dialect.name == "sqlite" else pg_insert
        result = db.execute(insert(Processed).values(id=event_id).on_conflict_do_nothing(index_elements=["id"]))
        if not result.rowcount:
            return
        order = db.scalar(select(Order).where(Order.id == order_id).with_for_update())
        if not order or order.user_id != user_id or order.status not in PAID_STATES:
            return
        if status == "PREPARING":
            return
        if status == "IN_TRANSIT":
            return
        if status == "CANCELLED":
            # Order owns cancellation; a shipment can only be cancelled before dispatch.
            if order.status in ("PAID", "PREPARING"):
                from .orders import enqueue
                from .security import Caller
                update_status(order, status)
                enqueue(db, "order.cancelled", order, Caller(UUID(user_id), frozenset(), event["requestId"]))
        elif PAID_STATES.index(status) > PAID_STATES.index(order.status):
            update_status(order, status)


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
            async with await aio_pika.connect(host=settings.rabbitmq_host, login="order-service",
                    password=settings.order_rabbitmq_password, timeout=2) as connection:
                channel = await connection.channel(publisher_confirms=True, on_return_raises=True)
                await channel.set_qos(prefetch_count=10)
                queue = await channel.get_queue("order.q", ensure=True)
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
                                timestamp=datetime.fromisoformat(event["occurredAt"]), type=event["type"], app_id="order-service",
                                correlation_id=event["requestId"], delivery_mode=aio_pika.DeliveryMode.PERSISTENT),
                                routing_key=event["type"], mandatory=True, timeout=2)
                            db.delete(row)
                    await asyncio.sleep(0 if row else 0.5)
        except Exception:
            log.warning("RabbitMQ lub outbox niedostępny; ponowienie za 2 s")
            await asyncio.sleep(2)

