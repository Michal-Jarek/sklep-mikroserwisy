"""Consul: configuration from KV (D14), registration (D13) and finding other services (D13).

The registration code follows docs/patterns.md, section 2: start without Consul, retries in the
background, a check every 15 s that the entry still exists, deregistration on shutdown.
"""

import asyncio
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from time import monotonic

import httpx
import yaml

from .config import SERVICE_NAME, Settings
from .logs import logger, reason

REGISTRATION_CHECK_SECONDS = 15
MAX_RETRY_SECONDS = 15
DISCOVERY_CACHE_SECONDS = 10


async def load_kv(consul: httpx.AsyncClient) -> dict:
    """The YAML document under config/product-service/data, or {} (with a warning) when missing."""
    try:
        response = await consul.get(f"/v1/kv/config/{SERVICE_NAME}/data", params={"raw": "true"})
        if response.status_code == 404:
            logger.warning("No configuration in Consul KV, using defaults")
            return {}
        response.raise_for_status()
        values = yaml.safe_load(response.text) or {}
        if not isinstance(values, dict):
            raise ValueError("the value is not a YAML mapping")
        return values
    except (httpx.HTTPError, yaml.YAMLError, ValueError) as exc:
        logger.warning("Configuration from Consul KV not loaded, using defaults", extra=reason(exc))
        return {}


class Registration:
    def __init__(self, consul: httpx.AsyncClient, settings: Settings, is_ready: Callable[[], Awaitable[bool]]):
        self.consul = consul
        self.settings = settings
        self.is_ready = is_ready

    def own_address(self) -> str:
        """The IP address of this instance on the route to Consul (connect() of UDP sends nothing)."""
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect((self.settings.consul_host, self.settings.consul_port))
            address = sock.getsockname()[0]
        if address.startswith("127."):
            raise RuntimeError("the route to Consul uses a loopback address, set SERVICE_ADDRESS")
        return address

    async def is_registered(self, address: str) -> bool:
        response = await self.consul.get(f"/v1/agent/service/{self.settings.instance_id}")
        if response.status_code == 404:
            return False
        response.raise_for_status()
        service = response.json()
        return service.get("Address") == address and service.get("Port") == self.settings.port

    async def register(self, address: str) -> None:
        status = "passing" if await self.is_ready() else "critical"
        port = self.settings.port
        response = await self.consul.put(
            "/v1/agent/service/register",
            json={
                "ID": self.settings.instance_id,
                "Name": SERVICE_NAME,
                "Address": address,
                "Port": port,
                "Check": {
                    "HTTP": f"http://{address}:{port}/health/ready",
                    "Interval": "10s",
                    "Timeout": "2s",
                    "DeregisterCriticalServiceAfter": "1m",
                    "Status": status,
                },
            },
        )
        response.raise_for_status()
        fields = {"instanceId": self.settings.instance_id, "address": address}
        logger.info("Registered in Consul", extra={"fields": fields})

    async def keep_registered(self) -> None:
        """Background task: never ends on an error. One warning per Consul outage, then retries."""
        reachable = True
        retry_in = 1
        while True:
            try:
                address = self.settings.service_address or await asyncio.wait_for(
                    asyncio.to_thread(self.own_address), 2
                )
                if not await self.is_registered(address):
                    await self.register(address)
                if not reachable:
                    reachable = True
                    logger.info("Consul is reachable again")
                retry_in = 1
                await asyncio.sleep(REGISTRATION_CHECK_SECONDS)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                if reachable:
                    reachable = False
                    logger.warning("Consul is not reachable, will retry the registration", extra=reason(exc))
                await asyncio.sleep(retry_in)
                retry_in = min(retry_in * 2, MAX_RETRY_SECONDS)

    async def deregister(self) -> None:
        try:
            response = await self.consul.put(f"/v1/agent/service/deregister/{self.settings.instance_id}")
            response.raise_for_status()
            logger.info("Deregistered from Consul", extra={"fields": {"instanceId": self.settings.instance_id}})
        except httpx.HTTPError as exc:
            logger.warning("Deregistration from Consul failed", extra=reason(exc))


@dataclass
class _Instances:
    urls: list[str]
    expires_at: float
    index: int = 0
    dropped: set[str] = field(default_factory=set)


class Discovery:
    """Healthy instances of another service: /v1/health/service/<name>?passing, kept 10 s,
    round robin; when Consul fails, the last known list; an instance without a connection
    is skipped until the next refresh (D13). A fixed URL (tests, local work) skips Consul."""

    def __init__(self, consul: httpx.AsyncClient | None, fixed: dict[str, str] | None = None):
        self.consul = consul
        self.fixed = {name: url.rstrip("/") for name, url in (fixed or {}).items() if url}
        self.cache: dict[str, _Instances] = {}
        self.lock = asyncio.Lock()

    async def pick(self, name: str) -> str | None:
        if name in self.fixed:
            return self.fixed[name]
        if self.consul is None:
            return None
        async with self.lock:
            entry = self.cache.get(name)
            if entry is None or entry.expires_at <= monotonic():
                try:
                    response = await self.consul.get(f"/v1/health/service/{name}", params={"passing": "true"})
                    response.raise_for_status()
                    urls = []
                    for node in response.json():
                        service = node["Service"]
                        address = service.get("Address") or node["Node"]["Address"]
                        urls.append(f"http://{address}:{int(service['Port'])}")
                    entry = _Instances(urls, monotonic() + DISCOVERY_CACHE_SECONDS)
                    self.cache[name] = entry
                except Exception as exc:
                    logger.warning("Consul lookup failed, using the last known instances",
                                   extra={"fields": {"target": name, **reason(exc)["fields"]}})
                    if entry is None:
                        return None
                    # Do not ask Consul again on every request while it is down.
                    entry.expires_at = monotonic() + DISCOVERY_CACHE_SECONDS
            usable = [url for url in entry.urls if url not in entry.dropped]
            if not usable:
                return None
            url = usable[entry.index % len(usable)]
            entry.index += 1
            return url

    def drop(self, name: str, url: str) -> None:
        """No connection to this instance: skip it until the list is refreshed."""
        entry = self.cache.get(name)
        if entry is not None and name not in self.fixed:
            entry.dropped.add(url)
