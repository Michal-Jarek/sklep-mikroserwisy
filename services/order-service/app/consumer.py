"""Consumer of order.q (docs/events.md "Jak odbierać", wytyczne etapu 8 section 3.3).

The order-service account may only read order.q: the queue is opened passively, nothing is declared.
connect_robust restores the connection, the channel and the consumer after a broker restart. A deleted queue
cancels the consumer without an error in the client, so the queue is checked every QUEUE_CHECK_SECONDS; when it is
missing, the consumer connects again after RECONNECT_DELAY until the platform recreates it.
A temporary error is retried in the process (after 5 s, then 30 s, each with a random addition up to +50 %); after
the third failed attempt the message is rejected (nack, requeue=False) and the broker moves it to order.dlq.
An invalid envelope is rejected at once. requeue=True is never used.
Every message leaves one line: info after ack (processed, duplicate eventId, type not handled) or error with nack.
"""
import asyncio
import json
import logging
import random
from functools import partial
from typing import Callable

import aio_pika
from aio_pika.abc import AbstractIncomingMessage

from . import events
from .http_support import REQUEST_ID
from .logging_config import request_id_var, user_id_var

log = logging.getLogger("app.consumer")

QUEUE = "order.q"
PREFETCH = 10
MAX_ATTEMPTS = 3
RETRY_DELAYS = (5, 30)  # after the 1st and the 2nd failed attempt
JITTER = 0.5
RECONNECT_DELAY = 5
QUEUE_CHECK_SECONDS = 15
SUCCESS = {  # result of events.handle -> the info line after ack (the same texts as Shipping)
    "processed": "Event processed",
    "duplicate": "Event already processed (duplicate eventId), acknowledged",
    "ignored": "Event type not handled, acknowledged",
}


def retry_delay(base: float, rand: Callable[[], float] = random.random) -> float:
    return base * (1 + JITTER * rand())


async def process_with_retries(handler: Callable[[events.Event], str], event: events.Event,
                               delays=None, sleep=None) -> str:
    """Runs the handler in a thread up to MAX_ATTEMPTS times and returns its result; after the last failure the
    exception goes up."""
    delays, sleep = delays or RETRY_DELAYS, sleep or asyncio.sleep
    attempt = 1
    while True:
        try:
            return await asyncio.to_thread(handler, event)
        except Exception as exc:  # noqa: BLE001 - every error of the handler is temporary
            if attempt >= MAX_ATTEMPTS:
                raise
            delay = retry_delay(delays[attempt - 1])
            log.warning("Event processing failed, retry", extra={"fields": {
                "eventId": event.event_id, "type": event.type, "reason": type(exc).__name__,
                "attempt": attempt, "retryInSeconds": round(delay, 1)}})
            await sleep(delay)
            attempt += 1


def rejected_ids(message: AbstractIncomingMessage) -> tuple[str | None, str | None]:
    """eventId and requestId of a rejected message for the log.

    eventId from the body when it is JSON, otherwise the AMQP message_id; requestId only when the envelope has one
    that passes the X-Request-Id rule (like Inventory and Shipping), otherwise None.
    """
    try:
        body = json.loads(message.body)
    except Exception:  # noqa: BLE001
        body = None
    body = body if isinstance(body, dict) else {}
    event_id = body.get("eventId")
    if not isinstance(event_id, str):
        event_id = message.message_id
    request_id = body.get("requestId")
    return (event_id[:64] if isinstance(event_id, str) else None,
            request_id if isinstance(request_id, str) and REQUEST_ID.fullmatch(request_id) else None)


async def on_message(message: AbstractIncomingMessage, handler: Callable[[events.Event], str]) -> None:
    try:
        event = events.parse_envelope(message.body, message.routing_key)
    except Exception as exc:  # noqa: BLE001 - any error while reading the envelope: straight to the DLQ
        event_id, request_id = rejected_ids(message)
        request_token = request_id_var.set(request_id)
        log.error("Event rejected to order.dlq: invalid envelope", extra={"fields": {
            "eventId": event_id, "type": message.routing_key, "reason": str(exc)[:100]
            if isinstance(exc, events.InvalidEvent) else type(exc).__name__}})
        request_id_var.reset(request_token)
        await message.nack(requeue=False)
        return
    request_token = request_id_var.set(event.request_id)
    user_token = user_id_var.set(event.user_id)
    try:
        outcome = await process_with_retries(handler, event)
    except Exception as exc:  # noqa: BLE001
        log.error("Event rejected to order.dlq after 3 attempts", extra={"fields": {
            "eventId": event.event_id, "type": event.type, "reason": type(exc).__name__}})
        await message.nack(requeue=False)
    else:
        await message.ack()
        # requestId (envelope) and userId (payload) come from the context variables set above.
        log.info(SUCCESS[outcome], extra={"fields": {
            "eventId": event.event_id, "type": event.type, "orderId": event.order_id}})
    finally:
        request_id_var.reset(request_token)
        user_id_var.reset(user_token)


async def run_consumer(settings, factory, instance_id: str) -> None:
    handler = partial(events.handle, factory)
    while True:  # the service may start before the broker, so the first connection is retried here
        try:
            # Connection name in the management UI: aio-pika puts client_properties into the URL query and
            # aiormq reads only "name" from it ("connection_name" would be ignored).
            connection = await aio_pika.connect_robust(
                host=settings.rabbitmq_host, port=settings.rabbitmq_port, login=settings.rabbitmq_user,
                password=settings.rabbitmq_password, client_properties={"name": instance_id})
            async with connection:
                channel = await connection.channel()
                await channel.set_qos(prefetch_count=PREFETCH)
                queue = await channel.get_queue(QUEUE, ensure=True)  # passive only
                await queue.consume(partial(on_message, handler=handler))
                log.info("Consumer listens on %s", QUEUE)
                while True:
                    await asyncio.sleep(QUEUE_CHECK_SECONDS)
                    try:
                        await channel.get_queue(QUEUE, ensure=True)
                    except aio_pika.exceptions.ChannelNotFoundEntity:
                        raise  # the queue is gone: warning below and a new connection
                    except (aio_pika.exceptions.AMQPError, ConnectionError, asyncio.TimeoutError):
                        pass  # connection interrupted: connect_robust restores it
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - only the class in the log (no address, no password)
            log.warning("RabbitMQ consumer stopped, reconnect in %s s", RECONNECT_DELAY,
                        extra={"fields": {"reason": type(exc).__name__}})
            await asyncio.sleep(RECONNECT_DELAY)
