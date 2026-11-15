"""Konfiguracja z Consul KV (D14): klucz config/<usługa>/data to dokument YAML, na razie tylko "logLevel".

Kolejność: zmienne środowiskowe > KV > wartości domyślne. Bez Consula albo bez klucza usługa startuje z domyślnymi.
"""
import logging

import httpx
import yaml

from app.config import Settings
from app.logging_config import LOG_LEVELS

logger = logging.getLogger(__name__)


async def load_log_level(settings: Settings, transport: httpx.AsyncBaseTransport | None = None) -> str | None:
    url = f"http://{settings.consul_host}:{settings.consul_port}/v1/kv/config/{settings.service_name}/data"
    try:
        async with httpx.AsyncClient(timeout=2.0, transport=transport) as client:
            resp = await client.get(url, params={"raw": "true"})
        if resp.status_code == 404:
            logger.warning("Brak konfiguracji w Consul KV, używam wartości domyślnych")
            return None
        resp.raise_for_status()
        values = yaml.safe_load(resp.text) or {}
        if not isinstance(values, dict):
            raise ValueError("wartość nie jest mapą YAML")
    except (httpx.HTTPError, yaml.YAMLError, ValueError) as exc:
        logger.warning(
            "Nie wczytano konfiguracji z Consul KV, używam wartości domyślnych",
            extra={"fields": {"reason": type(exc).__name__}},
        )
        return None

    level = values.get("logLevel")
    if level is None:
        return None
    if str(level).lower() in LOG_LEVELS:
        return str(level).lower()
    logger.warning("Nieznany logLevel w Consul KV, pomijam")
    return None
