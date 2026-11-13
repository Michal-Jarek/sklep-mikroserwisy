"""Rejestracja instancji w Consulu (service discovery) z health checkiem /health/ready."""
import asyncio
import logging

import httpx

from app.config import Settings

logger = logging.getLogger(__name__)


class ConsulRegistrar:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.base = f"http://{settings.consul_host}:{settings.consul_port}/v1/agent/service"
        self.service_id = f"{settings.service_name}-{settings.effective_instance_id}"

    def _payload(self) -> dict:
        s = self.settings
        address = s.effective_address
        return {
            "ID": self.service_id,
            "Name": s.service_name,
            "Address": address,
            "Port": s.service_port,
            "Meta": {"instance_id": s.effective_instance_id},
            "Check": {
                "HTTP": f"http://{address}:{s.service_port}/health/ready",
                "Interval": "10s",
                "Timeout": "2s",
                "DeregisterCriticalServiceAfter": "1m",
            },
        }

    async def run(self) -> None:
        """Rejestruje usługę (z ponawianiem) i wyrejestrowuje ją przy zatrzymaniu zadania."""
        async with httpx.AsyncClient(timeout=2.0) as client:
            while True:
                try:
                    resp = await client.put(f"{self.base}/register", json=self._payload())
                    resp.raise_for_status()
                    logger.info("Zarejestrowano w Consulu jako %s", self.service_id)
                    break
                except httpx.HTTPError as exc:
                    logger.warning("Rejestracja w Consulu nieudana (%s), ponawiam za 5 s", exc)
                    await asyncio.sleep(5)
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                try:
                    await client.put(f"{self.base}/deregister/{self.service_id}")
                    logger.info("Wyrejestrowano z Consula")
                except httpx.HTTPError:
                    logger.warning("Nie udało się wyrejestrować z Consula")
                raise
