"""Odbiorca RabbitMQ według docs/events.md ("Jak odbierać", wariant z ponawianiem połączenia).

Konto inventory-service może tylko czytać z kolejki inventory.q: nie tworzymy exchange, kolejek
ani bindingów (kolejkę sprawdzamy pasywnie). Błąd chwilowy ponawiamy w procesie (po 5 s, potem po 30 s,
każdy odstęp z losowym dodatkiem do +50 %), a po trzeciej nieudanej próbie wiadomość odrzucamy
(nack, requeue=False) i broker sam przenosi ją do inventory.dlq. Niepoprawna koperta (także wyjątek przy jej
odczycie) jest odrzucana od razu, bez ponowień. Nigdy nie używamy requeue=True.

Połączenie wznawia connect_robust. Usunięta kolejka anuluje konsumenta po stronie brokera bez błędu w kliencie,
dlatego co 15 s sprawdzamy ją pasywnie; gdy jej nie ma, łączymy się od nowa co 5 s, aż kolejka wróci.
"""
import asyncio
import json
import logging
import random
from typing import Callable

import aio_pika

from app import events
from app.config import Settings
from app.ids import REQUEST_ID_PATTERN, valid_uuid
from app.logging_config import request_id_var

logger = logging.getLogger(__name__)

QUEUE = "inventory.q"
PREFETCH = 10
MAX_ATTEMPTS = 3
RETRY_DELAYS = (5, 30)  # odstęp po 1. i po 2. nieudanej próbie (bez losowego dodatku)
RETRY_JITTER = 0.5  # losowy dodatek do +50 %: zdarzenia po krótkiej awarii bazy nie wracają w tej samej chwili
RECONNECT_DELAY = 5
QUEUE_CHECK_INTERVAL = 15


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
            delay = delays[attempt - 1] * random.uniform(1, 1 + RETRY_JITTER)
            logger.warning(
                "Błąd przetwarzania zdarzenia, próba %s/%s, ponowienie za %.1f s", attempt, MAX_ATTEMPTS, delay,
                extra={"fields": {"eventId": envelope["eventId"], "type": envelope["type"], "reason": type(exc).__name__}},
            )
            await sleep(delay)
            attempt += 1


def _readable_ids(body: bytes) -> dict:
    """eventId i requestId odrzuconej koperty do logu - tylko gdy da się je odczytać i mają poprawny format."""
    try:
        envelope = json.loads(body)
        ids = {"eventId": valid_uuid(envelope.get("eventId"))}
        request_id = envelope.get("requestId")
        if isinstance(request_id, str) and REQUEST_ID_PATTERN.fullmatch(request_id):
            ids["requestId"] = request_id
    except Exception:  # noqa: BLE001 - koperta i tak jest odrzucana
        return {}
    return {key: value for key, value in ids.items() if value is not None}


async def _on_message(message: aio_pika.abc.AbstractIncomingMessage, handler: Callable[[dict], None]) -> None:
    try:
        envelope = events.parse_envelope(message.body, message.routing_key)
    except Exception as exc:  # noqa: BLE001 - każda wiadomość kończy się ack albo nack (np. RecursionError przy głębokim JSON)
        reason = str(exc) if isinstance(exc, events.InvalidEvent) else type(exc).__name__
        logger.error(
            "Odrzucono zdarzenie z błędną kopertą (%s), trafia do inventory.dlq", reason,
            extra={"fields": _readable_ids(message.body)},
        )
        await message.nack(requeue=False)
        return

    token = request_id_var.set(envelope["requestId"])
    try:
        await process_with_retries(handler, envelope)
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "Zdarzenie odrzucone po %s próbach, trafia do inventory.dlq", MAX_ATTEMPTS,
            extra={"fields": {"eventId": envelope["eventId"], "type": envelope["type"], "reason": type(exc).__name__}},
        )
        await message.nack(requeue=False)
    else:
        await message.ack()
    finally:
        request_id_var.reset(token)


async def watch_queue(channel: aio_pika.abc.AbstractChannel) -> None:
    """Co QUEUE_CHECK_INTERVAL sprawdza kolejkę pasywnie; brak kolejki kończy się wyjątkiem ChannelNotFoundEntity."""
    while True:
        await asyncio.sleep(QUEUE_CHECK_INTERVAL)
        try:
            await channel.get_queue(QUEUE, ensure=True)
        except aio_pika.exceptions.ChannelNotFoundEntity:
            raise
        except (aio_pika.exceptions.AMQPError, ConnectionError, RuntimeError, asyncio.TimeoutError):
            pass  # przerwa w połączeniu: connect_robust wznowi je sam, sprawdzimy przy następnej okazji


async def run_consumer(settings: Settings, handler: Callable[[dict], None]) -> None:
    async def on_message(message: aio_pika.abc.AbstractIncomingMessage) -> None:
        await _on_message(message, handler)

    while True:  # usługa może wystartować przed brokerem i bez kolejki, więc połączenie ponawiamy
        try:
            connection = await aio_pika.connect_robust(
                host=settings.rabbitmq_host,
                port=settings.rabbitmq_port,
                login=settings.rabbitmq_user,
                password=settings.rabbitmq_password,
                # nazwa połączenia w panelu RabbitMQ; aiormq 6.8 czyta klucz "name" (nie "connection_name")
                client_properties={"name": settings.effective_instance_id},
            )
            async with connection:
                channel = await connection.channel()
                await channel.set_qos(prefetch_count=PREFETCH)
                queue = await channel.get_queue(QUEUE, ensure=True)  # tylko pasywnie
                await queue.consume(on_message)
                logger.info("Odbiorca nasłuchuje kolejki %s", QUEUE)
                await watch_queue(channel)
        except asyncio.CancelledError:
            raise
        except aio_pika.exceptions.ChannelNotFoundEntity:
            logger.warning("Brak kolejki %s, ponowne połączenie za %s s", QUEUE, RECONNECT_DELAY)
        except Exception as exc:  # noqa: BLE001 - w logu tylko klasa wyjątku (adres i hasło nie trafiają do logów)
            logger.warning("Błąd połączenia z RabbitMQ (%s), ponawiam za %s s", type(exc).__name__, RECONNECT_DELAY)
        await asyncio.sleep(RECONNECT_DELAY)
