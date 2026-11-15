"""Z7: stale Consul entries are removed at the first successful registration of the process (and Z12: own ID → Z5)."""
import asyncio
import json
import logging
import httpx
import pytest
from app.discovery import Discovery

SERVICE, PORT, OWN_ID, ADDRESS = "cart-service", 8085, "cart-service-own", "10.0.0.1"


class FakeConsul:
    """Consul agent with entries of this service; records every call."""
    def __init__(self, others=(), own=False, health=None, fail_health=0, ready=200, deregister_errors=None):
        self.entries = {o["ID"]: o for o in others}
        if own:
            self.entries[OWN_ID] = {"ID": OWN_ID, "Address": ADDRESS, "Port": PORT}
        self.health, self.fail_health, self.ready = health, fail_health, ready
        self.deregister_errors = dict(deregister_errors or {})  # ID -> response or exception (once)
        self.calls, self.registered = [], []

    def respond(self, request):
        path = request.url.path
        self.calls.append((request.method, path))
        if path == "/health/ready":
            return httpx.Response(self.ready)
        if path == f"/v1/health/service/{SERVICE}":
            if self.fail_health:
                self.fail_health -= 1
                raise httpx.ConnectError("consul down")
            if self.health is not None:
                return self.health
            return httpx.Response(200, json=[{"Service": e} for e in self.entries.values()])
        if path.startswith("/v1/agent/service/deregister/"):
            error = self.deregister_errors.pop(path.rsplit("/", 1)[1], None)
            if isinstance(error, Exception):
                raise error
            if error is not None:
                return error
            self.entries.pop(path.rsplit("/", 1)[1], None)
            return httpx.Response(200)
        if path == "/v1/agent/service/register":
            body = json.loads(request.content)
            self.registered.append(body)
            self.entries[body["ID"]] = {"ID": body["ID"], "Address": body["Address"], "Port": body["Port"]}
            return httpx.Response(200)
        if path.startswith("/v1/agent/service/"):
            entry = self.entries.get(path.rsplit("/", 1)[1])
            return httpx.Response(404) if entry is None else httpx.Response(200, json=entry)
        return httpx.Response(500)

    def deregistered(self):
        return [p.rsplit("/", 1)[1] for m, p in self.calls if p.startswith("/v1/agent/service/deregister/")]


async def register(fake):
    async with httpx.AsyncClient(transport=httpx.MockTransport(fake.respond)) as client:
        discovery = Discovery(client, "http://consul", True, SERVICE, OWN_ID, ADDRESS, PORT)
        await discovery.try_register()
    return discovery


async def maintain(discovery, fake, cycles):
    """Runs maintain_registration for the given number of 15 s cycles (sleep replaced)."""
    real_sleep, ticks = asyncio.sleep, 0
    async def tick(_):
        nonlocal ticks
        ticks += 1
        if ticks > cycles:
            raise asyncio.CancelledError()
        await real_sleep(0)
    async with httpx.AsyncClient(transport=httpx.MockTransport(fake.respond)) as client:
        discovery.client = client
        asyncio.sleep = tick
        try:
            with pytest.raises(asyncio.CancelledError):
                await discovery.maintain_registration()
        finally:
            asyncio.sleep = real_sleep


def messages(caplog, level):
    return [json.loads(r.getMessage()) for r in caplog.records if r.name == "shop.discovery" and r.levelno == level]


async def test_orphan_with_same_address_and_port_is_removed_before_registration(caplog):
    fake = FakeConsul(others=[{"ID": "old-container", "Address": ADDRESS, "Port": PORT}])
    with caplog.at_level(logging.INFO, logger="shop.discovery"):
        await register(fake)
    puts = [p for m, p in fake.calls if m == "PUT"]
    assert puts.index("/v1/agent/service/deregister/old-container") < puts.index("/v1/agent/service/register")
    assert set(fake.entries) == {OWN_ID} and len(fake.registered) == 1
    assert {"message": "Removed orphaned Consul entry", "removedId": "old-container"} in messages(caplog, logging.INFO)


@pytest.mark.parametrize("other", [
    {"ID": "other-address", "Address": "10.0.0.2", "Port": PORT},
    {"ID": "other-port", "Address": ADDRESS, "Port": PORT + 1},
])
async def test_entry_with_other_address_or_port_is_left_alone(other):
    fake = FakeConsul(others=[other])
    await register(fake)
    assert fake.deregistered() == [] and other["ID"] in fake.entries and len(fake.registered) == 1


@pytest.mark.parametrize("health", [httpx.Response(500), httpx.Response(200, text="not json"),
                                    httpx.Response(200, json={"no": "list"})])
async def test_cleanup_error_logs_one_warning_and_registration_still_happens(health, caplog):
    fake = FakeConsul(health=health)
    with caplog.at_level(logging.INFO, logger="shop.discovery"):
        discovery = await register(fake)
    assert len(fake.registered) == 1 and discovery.registered
    assert [m["message"] for m in messages(caplog, logging.WARNING)] == [
        "Consul cleanup of orphaned entries failed; registering anyway"]


async def test_consul_down_at_start_cleanup_runs_at_first_successful_contact():
    fake = FakeConsul(fail_health=1, others=[{"ID": "old-container", "Address": ADDRESS, "Port": PORT}])
    discovery = await register(fake)
    assert fake.registered == [] and not discovery.registered  # attempt aborted like registration
    await maintain(discovery, fake, cycles=1)
    assert fake.deregistered()[0] == "old-container" and len(fake.registered) == 1


async def test_cleanup_only_at_start_not_in_periodic_checks():
    fake = FakeConsul()
    discovery = await register(fake)
    fake.entries.clear()  # Consul forgot the instance: periodic check registers again, without cleanup
    await maintain(discovery, fake, cycles=3)
    health = [p for m, p in fake.calls if p == f"/v1/health/service/{SERVICE}"]
    assert len(health) == 1 and len(fake.registered) == 2


async def test_own_entry_goes_through_z5_path_and_orphan_is_removed_too(caplog):
    fake = FakeConsul(own=True, others=[{"ID": "old-container", "Address": ADDRESS, "Port": PORT}])
    with caplog.at_level(logging.INFO, logger="shop.discovery"):
        await register(fake)
    puts = [p for m, p in fake.calls if m == "PUT"]
    assert puts == ["/v1/agent/service/deregister/old-container", f"/v1/agent/service/deregister/{OWN_ID}",
                    "/v1/agent/service/register"]
    assert {"message": "Removed Consul entry left by previous process", "instanceId": OWN_ID} in messages(caplog, logging.INFO)


async def test_no_own_deregistration_at_start_when_there_is_no_entry():
    fake = FakeConsul()
    await register(fake)
    assert fake.deregistered() == [] and len(fake.registered) == 1


async def test_entry_found_after_consul_outage_at_start_still_registers_with_cleanup():
    fake = FakeConsul(fail_health=1, others=[{"ID": "old-container", "Address": ADDRESS, "Port": PORT}], own=True)
    discovery = await register(fake)
    await maintain(discovery, fake, cycles=1)
    assert fake.deregistered() == ["old-container", OWN_ID] and len(fake.registered) == 1


@pytest.mark.parametrize("ready, status", [(200, "passing"), (503, "critical")])
async def test_initial_check_status_follows_own_readiness(ready, status):
    fake = FakeConsul(ready=ready)
    await register(fake)
    assert fake.registered[0]["Check"]["Status"] == status


# --- CR-34: a refused orphan does not stop the loop ------------------------------------------------

async def test_refused_orphan_does_not_stop_the_loop_and_gives_one_warning(caplog):
    fake = FakeConsul(others=[{"ID": "old-1", "Address": ADDRESS, "Port": PORT}, {"ID": "old-2", "Address": ADDRESS, "Port": PORT}],
                      deregister_errors={"old-1": httpx.Response(403, text="service entry not found")})
    with caplog.at_level(logging.INFO, logger="shop.discovery"):
        await register(fake)
    assert fake.deregistered()[:2] == ["old-1", "old-2"]
    assert "old-2" not in fake.entries and "old-1" in fake.entries and len(fake.registered) == 1
    assert messages(caplog, logging.WARNING) == [
        {"message": "Consul cleanup of orphaned entries failed; registering anyway", "reason": "HTTP 403", "failed": 1}]
    assert [m["removedId"] for m in messages(caplog, logging.INFO) if "removedId" in m] == ["old-2"]


async def test_connection_error_while_removing_an_orphan_still_aborts_the_attempt():
    fake = FakeConsul(others=[{"ID": "old-1", "Address": ADDRESS, "Port": PORT}],
                      deregister_errors={"old-1": httpx.ConnectError("consul down")})
    discovery = await register(fake)
    assert fake.registered == [] and not discovery.registered  # attempt aborted like registration
    await maintain(discovery, fake, cycles=1)
    assert "old-1" not in fake.entries and len(fake.registered) == 1
