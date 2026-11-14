"""Odbiorca RabbitMQ według docs/events.md ("Jak odbierać").

Konto inventory-service może tylko czytać z kolejki inventory.q: nie tworzymy exchange, kolejek
ani bindingów (kolejkę sprawdzamy pasywnie). Błąd chwilowy ponawiamy w procesie (po 5 s, potem po 30 s),
a po trzeciej nieudanej próbie wiadomość odrzucamy (nack, requeue=False) i broker sam przenosi ją do inventory.dlq.
Niepoprawna koperta jest odrzucana od razu, bez ponowień. Nigdy nie używamy requeue=True.
"""
import asyncio
import logging
from typing import Callable

import aio_pika

from app import events
from app.config import Settings
from app.logging_config import request_id_var

logger = logging.getLogger(__name__)

QUEUE = "inventory.q"
PREFETCH = 10
MAX_ATTEMPTS = 3
RETRY_DELAYS = (5, 30)  # odstęp po 1. i po 2. nieudanej próbie
RECONNECT_DELAY = 5


async def process_with_retries(handler: Callable[[dict], None], envelope: dict, delays=RETRY_DELAYS, sleep=asyncio.sleep) -> None:
    """Wywołuje handler do MAX_ATTEMPTS razy; po ostatniej nieudanej próbie rzuca wyjątek."""
    attempt = 1
    while True:
        try:
            await asyncio.to_thread(handler, envelope)
            return
        except Exception as exc:  # noqa: BLE001 - każdy błąd przetwarzania to błąd chwilowy
            if attempt >= MAX_ATTEMPTS:
                raise
            delay = delays[attempt - 1]
            logger.warning(
                "Zdarzenie %s (%s): błąd %s, próba %s/%s, ponowienie za %s s",
                envelope["eventId"], envelope["type"], type(exc).__name__, attempt, MAX_ATTEMPTS, delay,
            )
            await sleep(delay)
            attempt += 1


async def _on_message(message: aio_pika.abc.AbstractIncomingMessage, handler: Callable[[dict], None]) -> None:
    try:
        envelope = events.parse_envelope(message.body, message.routing_key)
    except events.InvalidEvent as exc:
        logger.error("Odrzucono zdarzenie z błędną kopertą (%s), trafia do inventory.dlq", exc)
        await message.nack(requeue=False)
        return

    token = request_id_var.set(envelope.get("requestId"))
    try:
        await process_with_retries(handler, envelope)
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "Zdarzenie %s (%s) odrzucone po %s próbach (%s), trafia do inventory.dlq",
            envelope["eventId"], envelope["type"], MAX_ATTEMPTS, type(exc).__name__,
        )
        await message.nack(requeue=False)
    else:
        await message.ack()
    finally:
        request_id_var.reset(token)


async def run_consumer(settings: Settings, handler: Callable[[dict], None]) -> None:
    while True:  # usługa może wystartować przed brokerem, więc połączenie ponawiamy
        try:
            connection = await aio_pika.connect_robust(
                host=settings.rabbitmq_host,
                port=settings.rabbitmq_port,
                login=settings.rabbitmq_user,
                password=settings.rabbitmq_password,
            )
            async with connection:
                channel = await connection.channel()
                await channel.set_qos(prefetch_count=PREFETCH)
                queue = await channel.get_queue(QUEUE, ensure=True)  # tylko pasywnie

                async def on_message(message: aio_pika.abc.AbstractIncomingMessage) -> None:
                    await _on_message(message, handler)

                await queue.consume(on_message)
                logger.info("Odbiorca nasłuchuje kolejki %s", QUEUE)
                await asyncio.Future()  # działa do anulowania zadania
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - w logu tylko klasa wyjątku (adres i hasło nie trafiają do logów)
            logger.warning("Błąd połączenia z RabbitMQ (%s), ponawiam za %s s", type(exc).__name__, RECONNECT_DELAY)
            await asyncio.sleep(RECONNECT_DELAY)
