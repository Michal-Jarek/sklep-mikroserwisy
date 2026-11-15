"""Outbox relay (docs/patterns.md, "Outbox"): publishes shipping_outbox rows to shop.events.

Its own task and its own connection with publisher confirms, separate from the consumer of shipping.q.
Rows are taken under a lease (locked_until, FOR UPDATE SKIP LOCKED, a short transaction in a thread), published
without an open transaction and deleted after the broker confirms them (at least once: consumers are idempotent).
A database or broker error: a warning with the exception class and a pause of 2-5 s. A message the broker
cannot route (mandatory) stays in the outbox, logged as an error, and is retried when its lease expires.
"""
import asyncio
import json
import logging
import random
from datetime import datetime, timedelta, timezone
from time import monotonic

import aio_pika
from sqlalchemy import delete, or_, select, update

from .config import SERVICE_NAME, Settings
from .logging_config import request_id_var
from .models import Outbox

log = logging.getLogger("shipping.relay")

EXCHANGE = "shop.events"
BATCH = 10
LEASE = timedelta(seconds=30)
BATCH_SECONDS = 20  # no new row is started later, so a lease never expires during publishing
PUBLISH_TIMEOUT = 2
IDLE_SECONDS = 0.5


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def lease_rows(factory, now: datetime | None = None) -> list[tuple[int, dict]]:
    now = now or _now()
    with factory.begin() as db:
        rows = db.execute(select(Outbox.seq, Outbox.envelope)
                          .where(or_(Outbox.locked_until.is_(None), Outbox.locked_until <= now))
                          .order_by(Outbox.seq).limit(BATCH).with_for_update(skip_locked=True)).all()
        if rows:
            db.execute(update(Outbox).where(Outbox.seq.in_([row.seq for row in rows]))
                       .values(locked_until=now + LEASE))
    return [(row.seq, row.envelope) for row in rows]


def delete_row(factory, seq: int) -> None:
    with factory.begin() as db:
        db.execute(delete(Outbox).where(Outbox.seq == seq))


def release_rows(factory, seqs: list[int]) -> None:
    with factory.begin() as db:
        db.execute(update(Outbox).where(Outbox.seq.in_(seqs)).values(locked_until=None))


def _message(event: dict) -> aio_pika.Message:
    return aio_pika.Message(
        json.dumps(event).encode(), content_type="application/json", message_id=event["eventId"],
        timestamp=datetime.fromisoformat(event["occurredAt"]), type=event["type"], app_id=SERVICE_NAME,
        correlation_id=event["requestId"], delivery_mode=aio_pika.DeliveryMode.PERSISTENT)


async def relay_batch(exchange, factory) -> int:
    """Publishes one batch; returns the number of leased rows. A publishing error is raised after the
    remaining rows are released (they are retried at once after the pause, not after the lease)."""
    rows = await asyncio.to_thread(lease_rows, factory)
    started = monotonic()
    for index, (seq, event) in enumerate(rows):
        pending = [s for s, _ in rows[index:]]
        if monotonic() - started > BATCH_SECONDS:
            await asyncio.to_thread(release_rows, factory, pending)
            break
        fields = {"eventId": event["eventId"], "type": event["type"]}
        token = request_id_var.set(event.get("requestId"))
        try:
            try:
                await exchange.publish(_message(event), routing_key=event["type"], mandatory=True,
                                       timeout=PUBLISH_TIMEOUT)
            except aio_pika.exceptions.DeliveryError as exc:
                log.error("Broker did not accept the event, it stays in the outbox",
                          extra={"fields": fields | {"reason": type(exc).__name__}})
                continue
            except Exception:
                try:
                    await asyncio.to_thread(release_rows, factory, pending)
                except Exception:
                    pass  # the database is down as well: the lease expires by itself
                raise
            await asyncio.to_thread(delete_row, factory, seq)
        finally:
            request_id_var.reset(token)
    return len(rows)


async def _open_exchange(settings: Settings):
    connection = await aio_pika.connect_robust(
        host=settings.rabbitmq_host, port=settings.rabbitmq_port,
        login=settings.rabbitmq_user, password=settings.rabbitmq_password,
        # "name": see consumer.py (aio-pika 9.5 passes it to aiormq as the connection name).
        client_properties={"name": f"{settings.effective_instance_id}-relay"})
    try:
        channel = await connection.channel(publisher_confirms=True, on_return_raises=True)
        return connection, await channel.get_exchange(EXCHANGE, ensure=False)
    except BaseException:
        await connection.close()
        raise


async def run_relay(settings: Settings, factory) -> None:
    connection = exchange = None
    try:
        while True:
            try:
                if exchange is None:
                    connection, exchange = await _open_exchange(settings)
                if not await relay_batch(exchange, factory):
                    await asyncio.sleep(IDLE_SECONDS)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # only the class: messages may contain addresses
                log.warning("Outbox relay failed, pausing", extra={"fields": {"reason": type(exc).__name__}})
                await asyncio.sleep(random.uniform(2, 5))
    finally:
        if connection is not None:
            await connection.close()
