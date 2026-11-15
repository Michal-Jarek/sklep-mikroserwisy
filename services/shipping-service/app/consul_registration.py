"""Registration in Consul (D13): ID = INSTANCE_ID (default shipping-service-<hostname>), own IP, check of
/health/ready every 10 s.

Every CHECK_INTERVAL the entry is checked and registered again when it is missing or has another address (Consul
removed the instance after a database outage or was restarted). The first registration of a process removes an
entry left with the same ID by a killed predecessor (compose: same hostname; k8s: container restarted in the same
pod): Consul keeps the old check state (critical) on re-registration and ignores "Status". Before that it removes
entries of this service with the same address and port under another ID (Z7: compose recreated the container with a
new hostname and the same IP; k8s: a new pod got the IP of a killed one). When Consul does not answer: one warning per
outage and retries after 1, 2, 4, 8, 15, 15 ... s; the service works on without Consul. Only fields allowed by
consul-guard in k8s are sent. The instance is deregistered on shutdown (SIGTERM).
"""
import asyncio
import logging
import socket
from collections.abc import Callable
from urllib.parse import urlsplit

import httpx

from .config import SERVICE_NAME, Settings

log = logging.getLogger("shipping.consul")

CHECK_INTERVAL = 15.0
RETRY_INITIAL = 1.0
RETRY_MAX = 15.0
CONSUL_TIMEOUT = 2.0


def own_address(consul_host: str, consul_port: int) -> str:
    """Own IP on the route to Consul (connect() on a UDP socket only picks the route, it sends nothing)."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.connect((consul_host, consul_port))
        address = sock.getsockname()[0]
    if address.startswith("127."):
        raise RuntimeError("the route to Consul uses the loopback address, set SERVICE_ADDRESS")
    return address


class ConsulRegistrar:
    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None,
                 check_interval: float = CHECK_INTERVAL, retry_initial: float = RETRY_INITIAL,
                 retry_max: float = RETRY_MAX, is_ready: Callable[[], bool] = lambda: True):
        self.settings = settings
        # The same database check as /health/ready (blocking, so it runs in a thread); gives the initial "Status".
        self.is_ready = is_ready
        self.consul = urlsplit(settings.consul_url)
        self.base = f"{settings.consul_url.rstrip('/')}/v1/agent/service"
        # no query string: consul-guard in k8s allows only none, "passing" and "passing=true" here
        self.health_url = f"{settings.consul_url.rstrip('/')}/v1/health/service/{SERVICE_NAME}"
        self.service_id = settings.effective_instance_id
        self._transport = transport
        self._check_interval = check_interval
        self._retry_initial = retry_initial
        self._retry_max = retry_max

    async def _address(self) -> str:
        if self.settings.service_address:
            return self.settings.service_address
        # DNS in connect() blocks, so in a thread (at most 2 s)
        return await asyncio.wait_for(asyncio.to_thread(
            own_address, self.consul.hostname, self.consul.port or 8500), CONSUL_TIMEOUT)

    async def _is_registered(self, client: httpx.AsyncClient, address: str) -> bool:
        resp = await client.get(f"{self.base}/{self.service_id}")
        if resp.status_code == 404:
            return False
        resp.raise_for_status()
        entry = resp.json()
        # after a restart the same ID (same hostname) may point to an old address
        return entry.get("Address") == address and entry.get("Port") == self.settings.port

    async def _remove_orphans(self, client: httpx.AsyncClient, address: str) -> None:
        """Removes entries of this service with our address and port but another ID (Z7).

        A killed process leaves its entry; when a new container or pod gets the same IP, the old entry stays passing
        (its check reaches this process) and the instance is listed twice. consul-guard allows the deregistration,
        because the address of such an entry is the caller's. No connection to Consul ends the attempt like the
        registration (the cleanup runs again at the first successful contact, without a warning per retry). A wrong
        answer (HTTP other than 2xx, bad JSON) is one warning: the cleanup never blocks the registration. A refused
        deregistration of one orphan (e.g. the reaper removed it meanwhile: 403 from consul-guard) does not stop the
        others; one warning after the loop (CR-34).
        """
        try:
            resp = await client.get(self.health_url)
            resp.raise_for_status()
            orphans = [item["Service"]["ID"] for item in resp.json()
                       if item["Service"].get("Address") == address
                       and item["Service"].get("Port") == self.settings.port
                       and item["Service"]["ID"] != self.service_id]
        except httpx.TransportError:
            raise
        except (httpx.HTTPError, ValueError, KeyError, TypeError, AttributeError) as exc:
            log.warning("Could not remove orphaned entries from Consul, registering anyway",
                        extra={"fields": {"reason": type(exc).__name__}})
            return
        failed = 0
        for orphan_id in orphans:
            resp = await client.put(f"{self.base}/deregister/{orphan_id}")  # a TransportError ends the attempt
            if not resp.is_success:
                failed += 1
                continue
            log.info("Removed an orphaned entry from Consul", extra={"fields": {"removedId": orphan_id}})
        if failed:
            log.warning("Could not remove orphaned entries from Consul, registering anyway",
                        extra={"fields": {"reason": "HTTPStatusError", "failed": failed}})

    async def _register_at_start(self, client: httpx.AsyncClient) -> None:
        resp = await client.get(f"{self.base}/{self.service_id}")
        if resp.status_code == 404:
            return
        resp.raise_for_status()
        resp = await client.put(f"{self.base}/deregister/{self.service_id}")
        resp.raise_for_status()
        log.info("Removed the entry of a previous process from Consul", extra={"fields": {"instanceId": self.service_id}})

    async def _status(self) -> str:
        """Initial check state from the current readiness (CR-35): also a re-registration after Consul removed the
        entry during a database outage starts as critical, so the Gateway does not route here before the check."""
        try:
            ready = await asyncio.wait_for(asyncio.to_thread(self.is_ready), CONSUL_TIMEOUT)
        except Exception:  # also TimeoutError: the database does not answer
            ready = False
        return "passing" if ready else "critical"

    async def _register(self, client: httpx.AsyncClient, address: str) -> None:
        port = self.settings.port
        status = await self._status()
        resp = await client.put(f"{self.base}/register", json={
            "ID": self.service_id,
            "Name": SERVICE_NAME,
            "Address": address,
            "Port": port,
            "Check": {
                "HTTP": f"http://{address}:{port}/health/ready",
                "Interval": "10s",
                "Timeout": "2s",
                "DeregisterCriticalServiceAfter": "1m",
                # From the current readiness: when ready, the Gateway can route here before the first check runs.
                "Status": status,
            },
        })
        resp.raise_for_status()
        log.info("Registered in Consul", extra={"fields": {"instanceId": self.service_id, "address": address}})

    async def run(self) -> None:
        async with httpx.AsyncClient(timeout=CONSUL_TIMEOUT, transport=self._transport, trust_env=False) as client:
            reachable = True
            first = True
            retry_in = self._retry_initial
            try:
                while True:
                    try:
                        address = await self._address()
                        if first:
                            await self._remove_orphans(client, address)
                            await self._register_at_start(client)
                            await self._register(client, address)
                            first = False
                        elif not await self._is_registered(client, address):
                            await self._register(client, address)
                        if not reachable:
                            reachable = True
                            log.info("Consul reachable again")
                        retry_in = self._retry_initial
                        await asyncio.sleep(self._check_interval)
                    except Exception as exc:
                        if reachable:
                            reachable = False
                            log.warning("Consul unavailable, registration will be retried",
                                        extra={"fields": {"reason": type(exc).__name__}})
                        await asyncio.sleep(retry_in)
                        retry_in = min(retry_in * 2, self._retry_max)
            except asyncio.CancelledError:
                try:
                    resp = await client.put(f"{self.base}/deregister/{self.service_id}")
                    resp.raise_for_status()
                    log.info("Deregistered from Consul", extra={"fields": {"instanceId": self.service_id}})
                except httpx.HTTPError:
                    log.warning("Could not deregister from Consul")
                raise
