"""Konsument RabbitMQ: kolejka inventory.q (binding order.cancelled na exchange shop.events).

Wiadomość jest potwierdzana (ack) dopiero po przetworzeniu. Po nieudanej próbie trafia
z powrotem do kolejki (nagłówek x-attempts); po RABBITMQ_MAX_ATTEMPTS próbach ląduje w inventory.dlq.
"""
import asyncio
import json
import logging
from typing import Callable

import aio_pika
from aio_pika import DeliveryMode, ExchangeType

from app.config import Settings

logger = logging.getLogger(__name__)

ROUTING_KEY = "order.cancelled"


async def run_consumer(settings: Settings, handler: Callable[[dict], None]) -> None:
    dlq_name = settings.rabbitmq_queue.removesuffix(".q") + ".dlq"

    while True:
        try:
            connection = await aio_pika.connect_robust(settings.rabbitmq_url)
            async with connection:
                channel = await connection.channel()
                await channel.set_qos(prefetch_count=settings.rabbitmq_prefetch)
                exchange = await channel.declare_exchange(settings.rabbitmq_exchange, ExchangeType.TOPIC, durable=True)
                await channel.declare_queue(dlq_name, durable=True)
                queue = await channel.declare_queue(settings.rabbitmq_queue, durable=True)
                await queue.bind(exchange, routing_key=ROUTING_KEY)

                async def on_message(message: aio_pika.abc.AbstractIncomingMessage) -> None:
                    try:
                        envelope = json.loads(message.body)
                        await asyncio.to_thread(handler, envelope)
                    except Exception as exc:  # noqa: BLE001 - każdy błąd = ponowienie / DLQ
                        await _retry_or_dead_letter(channel, message, exc, settings.rabbitmq_queue, dlq_name,
                                                    settings.rabbitmq_max_attempts)
                    else:
                        await message.ack()

                await queue.consume(on_message)
                logger.info("Konsument nasłuchuje kolejki %s", settings.rabbitmq_queue)
                await asyncio.Future()  # działa do anulowania zadania
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.warning("Błąd połączenia z RabbitMQ, ponawiam za 5 s", exc_info=True)
            await asyncio.sleep(5)


async def _retry_or_dead_letter(channel, message, exc, queue_name, dlq_name, max_attempts) -> None:
    headers = dict(message.headers or {})
    attempts = int(headers.get("x-attempts", 0)) + 1
    headers["x-attempts"] = attempts
    headers["x-last-error"] = str(exc)[:200]

    if attempts >= max_attempts:
        target = dlq_name
        logger.error("Zdarzenie odrzucone po %s próbach, trafia do %s: %s", attempts, dlq_name, exc)
    else:
        target = queue_name
        logger.warning("Błąd przetwarzania zdarzenia (próba %s/%s): %s", attempts, max_attempts, exc)
        await asyncio.sleep(2 * attempts)

    await channel.default_exchange.publish(
        aio_pika.Message(
            body=message.body,
            headers=headers,
            delivery_mode=DeliveryMode.PERSISTENT,
            content_type=message.content_type,
        ),
        routing_key=target,
    )
    await message.ack()
