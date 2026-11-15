"""Consul registration recovery, startup KV and non-blocking cached discovery."""
import asyncio
import json
import logging
import socket
from urllib.parse import urlparse
from dataclasses import dataclass
from time import monotonic
import httpx
import yaml

logger = logging.getLogger("shop.discovery")

def report(event, exc=None):
    logger.warning(json.dumps({"message": event, "errorType": type(exc).__name__ if exc else None}))

@dataclass
class CachedInstances:
    urls: list[str]
    expires_at: float
    index: int = 0

class Discovery:
    def __init__(self, client, url, enabled, service_name, instance_id, address, port):
        self.client = client
        self.url = url.rstrip("/")
        self.enabled = enabled
        self.service_name = service_name
        self.instance_id = instance_id
        self.address = address
        self.port = port
        self.cache = {}
        self.refreshes = {}
        self.unreachable = {}
        # False until the first successful registration of this process: only then stale entries are cleaned up.
        self.registered = False

    async def load_settings(self, settings):
        if not self.enabled:
            return
        try:
            response = await self.client.get(f"{self.url}/v1/kv/config/{self.service_name}/data", params={"raw": "true"})
            response.raise_for_status()
            values = yaml.safe_load(response.text) or {}
            if not isinstance(values, dict):
                raise ValueError("KV must be a mapping")
            level = values.get("logLevel", "info")
            if level not in {"debug", "info", "warning", "error"}:
                raise ValueError("Unsupported log level")
            # Explicit constructor values, process env and .env have priority over KV.
            if "log_level" not in settings.model_fields_set:
                settings.log_level = level
        except (httpx.HTTPError, yaml.YAMLError, ValueError) as exc:
            report("Consul KV unavailable; using local configuration", exc)
        for name in ("shop.http", "shop.discovery", "shop.catalog", "uvicorn.error"):
            logging.getLogger(name).setLevel(settings.log_level.upper())

    async def register(self):
        if not self.enabled:
            return
        if not self.address:
            def own_address():
                parsed = urlparse(self.url)
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                    sock.connect((parsed.hostname, parsed.port or 8500))
                    return sock.getsockname()[0]
            self.address = await asyncio.wait_for(asyncio.to_thread(own_address), timeout=2)
        if not self.registered:
            await self.remove_orphans()
            await self.remove_previous_entry()
        response = await self.client.put(f"{self.url}/v1/agent/service/register", json={
            "ID": self.instance_id, "Name": self.service_name,
            "Address": self.address, "Port": self.port,
            "Check": {"HTTP": f"http://{self.address}:{self.port}/health/ready",
                      "Interval": "10s", "Timeout": "2s", "DeregisterCriticalServiceAfter": "1m", "Status": await self.readiness()}})
        response.raise_for_status()
        self.registered = True

    async def remove_orphans(self):
        # A container killed without deregistration and recreated gets a new ID and usually the same IP;
        # its old entry would stay in Consul as critical until DeregisterCriticalServiceAfter.
        # Connection errors abort the whole attempt (retried like registration); a bad answer only warns.
        try:
            response = await self.client.get(f"{self.url}/v1/health/service/{self.service_name}")
            response.raise_for_status()
            orphans = [node["Service"]["ID"] for node in response.json()
                       if node["Service"]["Address"] == self.address and node["Service"]["Port"] == self.port
                       and node["Service"]["ID"] != self.instance_id]
        except (httpx.HTTPStatusError, ValueError, KeyError, TypeError) as exc:
            report("Consul cleanup of orphaned entries failed; registering anyway", exc)
            return
        # A refused deregistration (e.g. 403 when Consul removed the entry meanwhile) does not stop the loop:
        # the other orphans are still removed and the failures give one warning after it.
        failed, reason = 0, None
        for orphan_id in orphans:
            response = await self.client.put(f"{self.url}/v1/agent/service/deregister/{orphan_id}")
            if not response.is_success:
                failed, reason = failed + 1, f"HTTP {response.status_code}"
                continue
            logger.info(json.dumps({"message": "Removed orphaned Consul entry", "removedId": orphan_id}))
        if failed:
            logger.warning(json.dumps({"message": "Consul cleanup of orphaned entries failed; registering anyway",
                                       "reason": reason, "failed": failed}))

    async def remove_previous_entry(self):
        # An entry with our own ID left by a process killed without deregistration keeps its old check
        # state (e.g. critical) when registered again, and Consul ignores "Status"; so it is removed first.
        response = await self.client.get(f"{self.url}/v1/agent/service/{self.instance_id}")
        if response.status_code == 404:
            return
        response.raise_for_status()
        response = await self.client.put(f"{self.url}/v1/agent/service/deregister/{self.instance_id}")
        response.raise_for_status()
        logger.info(json.dumps({"message": "Removed Consul entry left by previous process", "instanceId": self.instance_id}))

    async def readiness(self):
        # Initial check state: Consul runs the first check up to one interval later.
        try:
            response = await self.client.get(f"http://127.0.0.1:{self.port}/health/ready")
            return "passing" if response.status_code == 200 else "critical"
        except httpx.HTTPError:
            return "critical"

    async def try_register(self):
        try:
            await self.register()
        except (httpx.HTTPError, OSError, TimeoutError) as exc:
            report("Consul unavailable; registration will retry", exc)

    async def maintain_registration(self):
        if not self.enabled:
            return
        while True:
            await asyncio.sleep(15)
            try:
                response = await self.client.get(f"{self.url}/v1/agent/service/{self.instance_id}")
                # Consul was down at start: the first successful contact still registers (with cleanup).
                if not self.registered or response.status_code == 404:
                    await self.register()
                else:
                    response.raise_for_status()
                    current = response.json()
                    if current.get("Address") != self.address or current.get("Port") != self.port:
                        await self.register()
            except (httpx.HTTPError, ValueError, OSError, TimeoutError) as exc:
                report("Consul registration check failed; retrying in background", exc)

    async def deregister(self):
        if self.enabled:
            try:
                response = await self.client.put(f"{self.url}/v1/agent/service/deregister/{self.instance_id}")
                response.raise_for_status()
            except (httpx.HTTPError, OSError, TimeoutError) as exc:
                report("Consul deregistration failed", exc)

    async def refresh(self, name):
        response = await self.client.get(f"{self.url}/v1/health/service/{name}", params={"passing": "true"})
        response.raise_for_status()
        urls = []
        for node in response.json():
            service = node["Service"]
            address = service.get("Address") or node["Node"]["Address"]
            urls.append(f"http://{address}:{int(service['Port'])}")
        if not urls:
            raise RuntimeError("No healthy instances")
        self.cache[name] = CachedInstances(urls, monotonic() + 10)
        self.unreachable.pop(name, None)

    async def resolve(self, name):
        entry = self.cache.get(name)
        if entry is None or entry.expires_at <= monotonic():
            # One refresh per destination; unrelated destinations never share a lock.
            task = self.refreshes.get(name)
            if task is None or task.done():
                task = asyncio.create_task(self.refresh(name))
                self.refreshes[name] = task
            try:
                await asyncio.shield(task)
            except (httpx.HTTPError, RuntimeError, ValueError, KeyError, TypeError) as exc:
                report("Discovery refresh failed; using last known instances", exc)
                if entry is None:
                    raise
                entry.expires_at = monotonic() + 2
            entry = self.cache.get(name)
        candidates = [url for url in entry.urls if url not in self.unreachable.get(name, set())]
        if not candidates:
            raise RuntimeError("No reachable instances until next discovery refresh")
        result = candidates[entry.index % len(candidates)]
        entry.index += 1
        return result

    def reject(self, name, url):
        self.unreachable.setdefault(name, set()).add(url)

    async def close(self):
        for task in self.refreshes.values():
            task.cancel()
        await asyncio.gather(*self.refreshes.values(), return_exceptions=True)
        await self.deregister()
