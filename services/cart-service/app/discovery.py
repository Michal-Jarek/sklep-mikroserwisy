"""Rejestracja w Consulu i wybór zdrowych instancji (round robin)."""
import asyncio
from dataclasses import dataclass
from time import monotonic
import httpx

@dataclass
class CachedInstances:
    urls: list[str]
    expires_at: float
    index: int = 0


class Discovery:
    def __init__(self, client: httpx.AsyncClient, url: str, enabled: bool,
                 service_name: str, instance_id: str, address: str, port: int):
        self.client = client
        self.url = url.rstrip("/")
        self.enabled = enabled
        self.service_name = service_name
        self.instance_id = instance_id
        self.address = address
        self.port = port
        self.cache: dict[str, CachedInstances] = {}
        self.lock = asyncio.Lock()

    async def register(self) -> None:
        if not self.enabled:
            return
        response = await self.client.put(f"{self.url}/v1/agent/service/register", json={
            "ID": self.instance_id, "Name": self.service_name,
            "Address": self.address, "Port": self.port,
            "Check": {"HTTP": f"http://{self.address}:{self.port}/health/ready",
                      "Interval": "10s", "DeregisterCriticalServiceAfter": "1m"},
        })
        response.raise_for_status()

    async def deregister(self) -> None:
        if self.enabled:
            try:
                response = await self.client.put(f"{self.url}/v1/agent/service/deregister/{self.instance_id}")
                response.raise_for_status()
            except httpx.HTTPError:
                pass  # Consul usunie martwą instancję również na podstawie health checka.

    async def resolve(self, service_name: str) -> str:
        async with self.lock:
            entry = self.cache.get(service_name)
            if entry is None or entry.expires_at <= monotonic():
                response = await self.client.get(f"{self.url}/v1/health/service/{service_name}", params={"passing": "true"})
                response.raise_for_status()
                urls = []
                for node in response.json():
                    service = node["Service"]
                    address = service.get("Address") or node["Node"]["Address"]
                    urls.append(f"http://{address}:{int(service['Port'])}")
                if not urls:
                    raise RuntimeError("Brak zdrowych instancji")
                entry = CachedInstances(urls, monotonic() + 10)
                self.cache[service_name] = entry
            result = entry.urls[entry.index % len(entry.urls)]
            entry.index += 1
            return result
