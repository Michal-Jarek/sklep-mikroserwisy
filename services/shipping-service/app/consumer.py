"""Consumer of shipping.q (docs/events.md, the connect_robust variant; the same pattern as Inventory and Order).

The shipping-service account may only read shipping.q: the queue is opened passively, no topology is declared.
A transient error is retried in the process (after 5 s, then after 30 s, each up to +50 % at random); after the
third failed attempt the message is rejected (nack, requeue=False) and the broker moves it to shipping.dlq.
An invalid envelope or payload is rejected at once. requeue=True is never used. The connection has its own
task, separate from the outbox relay: a database or publishing error never interrupts it.
"""
import asyncio
import logging
import random

import aio_pika

from .config import Settings
from .events import InvalidEvent, handle, parse_envelope
from .http_support import valid_uuid
from .logging_config import request_id_var, user_id_var

log = logging.getLogger("shipping.consumer")

QUEUE = "shipping.q"
PREFETCH = 10
MAX_ATTEMPTS = 3
RETRY_DELAYS = (5, 30)  # after the 1st and the 2nd failed attempt
RECONNECT_DELAY = 5
QUEUE_CHECK_SECONDS = 15  # a deleted queue cancels the consumer without an error in the client
SUCCESS = {
    "processed": "Event processed",
    "duplicate": "Event already processed (duplicate eventId), acknowledged",
    "ignored": "Event type not handled, acknowledged",
}


async def _settle(message, ack: bool) -> None:
    try:
        if ack:
            await message.ack()
        else:
            await message.nack(requeue=False)
    except Exception as exc:  # the channel closed meanwhile: the broker delivers the message again
        log.warning("Could not settle the message", extra={"fields": {"reason": type(exc).__name__}})


async def on_message(message, factory, sleep=asyncio.sleep) -> None:
    try:
        event = parse_envelope(message.body, message.routing_key)
    except Exception as exc:  # any error while reading the envelope: DLQ, never left unsettled
        token = request_id_var.set(getattr(exc, "request_id", None))
        log.error("Invalid event envelope, moved to shipping.dlq", extra={"fields": {
            "eventId": getattr(exc, "event_id", None), "type": message.routing_key, "reason": type(exc).__name__,
            "detail": str(exc) if isinstance(exc, InvalidEvent) else None}})
        request_id_var.reset(token)
        await _settle(message, ack=False)
        return

    fields = {"eventId": event["eventId"], "type": event["type"]}
    token = request_id_var.set(event["requestId"])
    user_id = event["payload"].get("userId")  # null in the log unless a valid UUID
    user_token = user_id_var.set(valid_uuid(user_id) if isinstance(user_id, str) else None)
    try:
        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                outcome, order_id = await asyncio.to_thread(handle, factory, event)
            except InvalidEvent as exc:
                log.error("Event rejected, moved to shipping.dlq",
                          extra={"fields": fields | {"reason": type(exc).__name__, "detail": str(exc)}})
                await _settle(message, ack=False)
                return
            except Exception as exc:  # database or another transient error
                if attempt == MAX_ATTEMPTS:
                    log.error("Event failed %s times, moved to shipping.dlq", MAX_ATTEMPTS,
                              extra={"fields": fields | {"reason": type(exc).__name__}})
                    await _settle(message, ack=False)
                    return
                delay = RETRY_DELAYS[attempt - 1] * random.uniform(1, 1.5)
                log.warning("Event failed (attempt %s/%s), retrying in %.1f s", attempt, MAX_ATTEMPTS, delay,
                            extra={"fields": fields | {"reason": type(exc).__name__}})
                await sleep(delay)
            else:
                await _settle(message, ack=True)
                # One info line per handled event (requestId of the envelope comes from the context variable).
                log.info(SUCCESS[outcome], extra={"fields": fields | {"orderId": order_id}})
                return
    finally:
        user_id_var.reset(user_token)
        request_id_var.reset(token)


async def run_consumer(settings: Settings, factory) -> None:
    while True:  # the service may start before the broker
        try:
            connection = await aio_pika.connect_robust(
                host=settings.rabbitmq_host, port=settings.rabbitmq_port,
                login=settings.rabbitmq_user, password=settings.rabbitmq_password,
                # aio-pika 9.5 puts client_properties into the URL query, and aiormq reads the connection name
                # only from its "name" key ("connection_name" never reaches the broker).
                client_properties={"name": settings.effective_instance_id})
            async with connection:
                channel = await connection.channel()
                await channel.set_qos(prefetch_count=PREFETCH)
                queue = await channel.get_queue(QUEUE, ensure=True)  # passive only

                async def consume(message) -> None:
                    await on_message(message, factory)

                await queue.consume(consume)
                log.info("Consumer listening on %s", QUEUE)
                while True:
                    await asyncio.sleep(QUEUE_CHECK_SECONDS)
                    try:
                        await channel.get_queue(QUEUE, ensure=True)
                    except aio_pika.exceptions.ChannelNotFoundEntity:
                        raise  # the queue is gone: warning below and a new connection
                    except (aio_pika.exceptions.AMQPError, ConnectionError, asyncio.TimeoutError):
                        pass  # a break in the connection: connect_robust resumes it by itself
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # only the class: the message may contain the broker address
            log.warning("RabbitMQ consumer unavailable, reconnecting in %s s", RECONNECT_DELAY,
                        extra={"fields": {"reason": type(exc).__name__}})
            await asyncio.sleep(RECONNECT_DELAY)
