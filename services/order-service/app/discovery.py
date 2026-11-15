"""Consul (D13): registration of this instance and the list of healthy instances of other services.

Registration: at the start of the process entries of earlier processes at the same address and port are removed and
a leftover entry with the same ID is replaced; then every CHECK_INTERVAL
the service checks that its entry exists with the current address and registers again when it does not (Consul
restarted, or removed the instance after a critical check). Start without Consul is
fine: one warning per outage and attempts after 1, 2, 4, 8, 15, 15 ... s. On shutdown the instance deregisters.
Lookup: the list is kept for CACHE_SECONDS and used round robin; when Consul does not answer, the last known list
is used for CACHE_SECONDS for every service, so one purchase waits for Consul at most once (Consul errors never
count towards the circuit breaker of the target service). An empty answer does not drop a known list at once
(EMPTY_GRACE_SECONDS).
"""
import asyncio
import logging
import socket
from dataclasses import dataclass
from time import monotonic
from typing import Awaitable, Callable
from urllib.parse import urlsplit

import httpx

log = logging.getLogger("app.discovery")

CHECK_INTERVAL = 15.0
RETRY_INITIAL = 1.0
RETRY_MAX = 15.0
CACHE_SECONDS = 10.0
HEALTH_QUERY = {"passing": "true"}
# After a restart Consul restores registrations from its data dir but lists an instance as passing only after its
# check has run again (1-2 s, at most the check interval), so for a moment it answers "no healthy instance" for
# services that are up. An empty answer after a non-empty list is therefore not trusted at once: the last known list
# is used until Consul has kept answering "empty" for this long without a break. Counted from the first empty answer
# of the series, not from the last non-empty one: a list is refreshed only on demand, and after a Consul outage plus
# the leader election the last non-empty answer is often older than this. A non-empty answer or a Consul error ends
# the series (an outage does not age the list: the last known list is used as before). A service whose instances
# really all failed is reported as unavailable (NoInstances) after at most this time.
EMPTY_GRACE_SECONDS = 30.0


class NoInstances(Exception):
    """Consul has no healthy instance and there is no last known list."""


def own_address(consul_host: str, consul_port: int) -> str:
    """Own IP address on the route to Consul (connect() on a UDP socket only picks the route, it sends nothing)."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.connect((consul_host, consul_port))
        address = sock.getsockname()[0]
    if address.startswith("127."):
        raise RuntimeError("route to Consul goes through the loopback address, set SERVICE_ADDRESS")
    return address


@dataclass
class CachedInstances:
    urls: list[str]
    expires_at: float
    index: int = 0
    empty_since: float | None = None  # first answer of the current series of empty answers (EMPTY_GRACE_SECONDS)


class Discovery:
    def __init__(self, client: httpx.AsyncClient, consul_url: str, service_name: str, instance_id: str,
                 address: str | None, port: int, check_interval: float = CHECK_INTERVAL,
                 retry_initial: float = RETRY_INITIAL, retry_max: float = RETRY_MAX,
                 ready: Callable[[], Awaitable[bool]] | None = None):
        self.client = client
        self.url = consul_url.rstrip("/")
        self.service_name = service_name
        self.instance_id = instance_id
        self.address = address
        self.port = port
        self.check_interval = check_interval
        self.retry_initial = retry_initial
        self.retry_max = retry_max
        self.ready = ready  # CR-35: the database check of /health/ready gives the status of a (re)registration
        self.cache: dict[str, CachedInstances] = {}
        self.consul_down_until = 0.0  # after a failed lookup, lists are not asked for until then
        # CR-37: services in the "last known list" mode since an empty answer, independent of the cache entry
        # (dropped after EMPTY_GRACE_SECONDS, reset of the series by a Consul error): one warning on entering it,
        # one info at the first non-empty answer.
        self.last_list_mode: set[str] = set()

    async def _own_address(self) -> str:
        if self.address:
            return self.address
        parts = urlsplit(self.url)
        # DNS in connect() blocks, so it runs in a thread (at most 2 s).
        return await asyncio.wait_for(asyncio.to_thread(own_address, parts.hostname, parts.port or 8500), 2)

    async def _entry(self) -> dict | None:
        response = await self.client.get(f"{self.url}/v1/agent/service/{self.instance_id}")
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.json()

    async def _is_registered(self, address: str) -> bool:
        entry = await self._entry()
        # After a restart the same ID (same hostname) may point to an old address.
        return entry is not None and entry.get("Address") == address and entry.get("Port") == self.port

    async def _remove_orphans(self, address: str) -> None:
        """Removes entries of this service at this address and port under another ID (Z7).

        A process killed without deregistration leaves its entry. When a new container (new hostname = new ID) or a
        new pod gets the same IP, the old entry stays passing, because its check now reaches this process, and the
        instance is listed twice. Only such entries are removed; consul-guard allows it, because their address is the
        caller's. No connection to Consul ends the attempt like the registration does (the loop retries the whole
        start, so the cleanup runs at the first successful contact, without a warning per retry). A wrong answer
        (HTTP other than 2xx, bad JSON) costs one warning and the registration goes on: it never blocks the start.
        """
        try:
            response = await self.client.get(f"{self.url}/v1/health/service/{self.service_name}")
            response.raise_for_status()
            orphans = [node["Service"]["ID"] for node in response.json()
                       if node["Service"].get("Address") == address and node["Service"].get("Port") == self.port
                       and node["Service"]["ID"] != self.instance_id]
        except httpx.TransportError:
            raise
        except (httpx.HTTPError, ValueError, KeyError, TypeError, AttributeError) as exc:
            log.warning("Could not remove orphaned entries from Consul, registering anyway",
                        extra={"fields": {"reason": type(exc).__name__}})
            return
        # CR-34: a refused deregistration (e.g. 403 when Consul's reaper removed the entry meanwhile) does not stop
        # the loop; the other orphans are still removed and the failures give one warning after it.
        failed, reason = 0, None
        for orphan in orphans:
            removed = await self.client.put(f"{self.url}/v1/agent/service/deregister/{orphan}")
            if not removed.is_success:
                failed, reason = failed + 1, f"HTTP {removed.status_code}"
                continue
            log.info("Removed an orphaned entry with this address from Consul", extra={"fields": {"removedId": orphan}})
        if failed:
            log.warning("Could not remove orphaned entries from Consul, registering anyway",
                        extra={"fields": {"reason": reason, "failed": failed}})

    async def _register_at_start(self, address: str) -> None:
        """First registration of this process.

        An entry with the same ID may be left by a process killed without deregistration (compose: the container
        restarted with the same hostname). Registering the same ID again keeps the old check state (e.g. critical
        from the outage) and ignores "Status", so such an entry is removed first. In Kubernetes the ID is the pod
        name: after a new pod there is no entry and no extra request. Entries under other IDs at this address are
        removed before that (_remove_orphans, Z7).
        """
        await self._remove_orphans(address)
        if await self._entry() is not None:
            response = await self.client.put(f"{self.url}/v1/agent/service/deregister/{self.instance_id}")
            response.raise_for_status()
            log.info("Removed the entry of the previous process from Consul",
                     extra={"fields": {"instanceId": self.instance_id}})
        await self._register(address)

    async def _register(self, address: str) -> None:
        # The current readiness, also when registering again during a database outage (Consul removed the entry
        # after DeregisterCriticalServiceAfter): "passing" then would send traffic here until the next check.
        status = "passing" if self.ready is None or await self.ready() else "critical"
        # Only the fields allowed by consul-guard in k8s (ID, Name, Address, Port, Check).
        response = await self.client.put(f"{self.url}/v1/agent/service/register", json={
            "ID": self.instance_id, "Name": self.service_name, "Address": address, "Port": self.port,
            "Check": {"HTTP": f"http://{address}:{self.port}/health/ready", "Interval": "10s", "Timeout": "2s",
                      "DeregisterCriticalServiceAfter": "1m", "Status": status},
        })
        response.raise_for_status()
        log.info("Registered in Consul", extra={"fields": {
            "instanceId": self.instance_id, "address": address, "status": status}})

    async def run_registration(self) -> None:
        reachable = True
        registered = False
        retry_in = self.retry_initial
        try:
            while True:
                try:
                    address = await self._own_address()
                    if not registered:
                        await self._register_at_start(address)
                        registered = True
                    elif not await self._is_registered(address):
                        await self._register(address)
                    if not reachable:
                        reachable = True
                        log.info("Consul reachable again")
                    retry_in = self.retry_initial
                    await asyncio.sleep(self.check_interval)
                except Exception as exc:  # noqa: BLE001 - the service works on without Consul
                    if reachable:
                        reachable = False
                        log.warning("Consul unavailable, will register again",
                                    extra={"fields": {"reason": type(exc).__name__}})
                    await asyncio.sleep(retry_in)
                    retry_in = min(retry_in * 2, self.retry_max)
        except asyncio.CancelledError:
            try:
                response = await self.client.put(f"{self.url}/v1/agent/service/deregister/{self.instance_id}")
                response.raise_for_status()
                log.info("Deregistered from Consul", extra={"fields": {"instanceId": self.instance_id}})
            except httpx.HTTPError:
                log.warning("Deregistration from Consul failed")
            raise

    async def resolve(self, service_name: str) -> str:
        entry = self.cache.get(service_name)
        now = monotonic()
        if entry is not None and entry.expires_at <= now < self.consul_down_until:
            # Consul failed a moment ago (e.g. no leader yet after its restart): do not wait for it again.
            entry.expires_at = self.consul_down_until
        if entry is None or entry.expires_at <= now:
            try:
                # Exactly "passing=true": consul-guard in k8s rejects any other query string with 403.
                response = await self.client.get(f"{self.url}/v1/health/service/{service_name}",
                                                  params=HEALTH_QUERY, timeout=2)
                response.raise_for_status()
                urls = [f"http://{node['Service'].get('Address') or node['Node']['Address']}:"
                        f"{int(node['Service']['Port'])}" for node in response.json()]
            except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
                self.consul_down_until = monotonic() + CACHE_SECONDS
                if entry is None:
                    raise NoInstances(service_name) from None
                # D13: last known list while Consul does not answer; asked again after CACHE_SECONDS.
                log.warning("Consul lookup failed, using the last known list",
                            extra={"fields": {"target": service_name, "reason": type(exc).__name__}})
                entry.expires_at = self.consul_down_until
                entry.empty_since = None  # an error ends a series of empty answers
            else:
                if not urls:
                    entry = self._empty_answer(service_name, entry)
                else:
                    if service_name in self.last_list_mode:
                        self.last_list_mode.discard(service_name)
                        log.info("Consul lists healthy instances again", extra={"fields": {"target": service_name}})
                    entry = CachedInstances(urls, monotonic() + CACHE_SECONDS)
                    self.cache[service_name] = entry
        url = entry.urls[entry.index % len(entry.urls)]
        entry.index += 1
        return url

    def _empty_answer(self, service_name: str, entry: CachedInstances | None) -> CachedInstances:
        """Consul answered with no healthy instance: the last known list for at most EMPTY_GRACE_SECONDS."""
        if entry is None:
            raise NoInstances(service_name)
        now = monotonic()
        if entry.empty_since is None:
            entry.empty_since = now
        if service_name not in self.last_list_mode:
            self.last_list_mode.add(service_name)
            log.warning("Consul lists no healthy instance, using the last known list",
                        extra={"fields": {"target": service_name}})
        if now - entry.empty_since >= EMPTY_GRACE_SECONDS:
            self.cache.pop(service_name, None)
            log.warning("Consul still lists no healthy instance, last known list dropped",
                        extra={"fields": {"target": service_name}})
            raise NoInstances(service_name)
        entry.expires_at = min(now + CACHE_SECONDS, entry.empty_since + EMPTY_GRACE_SECONDS)
        return entry
