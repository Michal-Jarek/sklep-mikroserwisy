"""Outbox relay (docs/patterns.md, section 7): sends order.created and order.cancelled saved with the order.

A separate task with its own connection, so an error here never interrupts the consumer of order.q.
Rows are leased (locked_until, SKIP LOCKED) in a short transaction in a thread; publishing runs without an open
transaction, with publisher confirms, mandatory=True and a 2 s limit; a confirmed row is deleted (at least once:
the consumers recognise duplicates by eventId). A database or broker error: warning with the exception class,
the rest of the batch is freed, pause 2-5 s. A message the broker returns (no route) stays in the outbox: error log,
retried after the lease, without stopping the other rows.
"""
import asyncio
import json
import logging
import random
from contextlib import suppress
from datetime import datetime

import aio_pika

from . import store

log = logging.getLogger("app.relay")

EXCHANGE = "shop.events"
PUBLISH_TIMEOUT = 2.0
BATCH_SECONDS = 20.0  # shorter than the lease (30 s): a leased row is never sent by two instances at once
IDLE_SECONDS = 0.5
ERROR_PAUSE = (2.0, 5.0)
RECONNECT_DELAY = 5


def message(envelope: dict) -> aio_pika.Message:
    return aio_pika.Message(
        json.dumps(envelope).encode(), content_type="application/json",
        delivery_mode=aio_pika.DeliveryMode.PERSISTENT, message_id=envelope["eventId"], type=envelope["type"],
        timestamp=datetime.fromisoformat(envelope["occurredAt"]), app_id="order-service",
        correlation_id=envelope["requestId"])


async def relay_batch(factory, exchange) -> int:
    """Sends one batch; returns the number of confirmed events. Database/broker errors go up."""
    rows = await asyncio.to_thread(store.lease_outbox, factory)
    loop = asyncio.get_running_loop()
    started = loop.time()
    sent = 0
    for index, (seq, envelope) in enumerate(rows):
        if loop.time() - started > BATCH_SECONDS:
            await asyncio.to_thread(store.free_outbox, factory, [s for s, _ in rows[index:]])
            break
        try:
            # The robust channel waits for the connection without a limit; the outer limit turns that into an error.
            async with asyncio.timeout(PUBLISH_TIMEOUT):
                await exchange.publish(message(envelope), routing_key=envelope["type"], mandatory=True,
                                       timeout=PUBLISH_TIMEOUT)
        except (aio_pika.exceptions.PublishError, aio_pika.exceptions.DeliveryError) as exc:
            log.error("Broker refused the event, it stays in the outbox", extra={"fields": {
                "eventId": envelope["eventId"], "type": envelope["type"], "reason": type(exc).__name__}})
            continue  # the row keeps its lease and is tried again after it
        except BaseException:
            with suppress(Exception):
                await asyncio.to_thread(store.free_outbox, factory, [s for s, _ in rows[index:]])
            raise
        await asyncio.to_thread(store.delete_outbox, factory, seq)
        sent += 1
    return sent


async def run_relay(settings, factory, instance_id: str) -> None:
    while True:  # the service may start before the broker
        try:
            connection = await aio_pika.connect_robust(
                host=settings.rabbitmq_host, port=settings.rabbitmq_port, login=settings.rabbitmq_user,
                password=settings.rabbitmq_password, client_properties={"name": f"{instance_id}-relay"})
            async with connection:
                channel = await connection.channel(publisher_confirms=True, on_return_raises=True)
                exchange = await channel.get_exchange(EXCHANGE, ensure=False)  # declared by the platform
                while True:
                    try:
                        sent = await relay_batch(factory, exchange)
                    except Exception as exc:  # noqa: BLE001 - database or broker; the consumer is not affected
                        log.warning("Outbox relay failed, pause", extra={"fields": {"reason": type(exc).__name__}})
                        await asyncio.sleep(random.uniform(*ERROR_PAUSE))
                        if channel.is_closed:
                            break  # closed for good (not restored by connect_robust): new connection
                        continue
                    if not sent:
                        await asyncio.sleep(IDLE_SECONDS)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            log.warning("RabbitMQ connection of the outbox relay failed, reconnect in %s s", RECONNECT_DELAY,
                        extra={"fields": {"reason": type(exc).__name__}})
            await asyncio.sleep(RECONNECT_DELAY)
