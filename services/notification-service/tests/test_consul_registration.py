"""Z7 and Z5 on the first registration of the process: entries of this service with our address and port but
another ID are removed (orphans), then an entry with our own ID (previous process) is removed and registered again."""

import asyncio
import logging

import httpx
import pytest

import app.consul as consul_module
from app.config import SERVICE_NAME, Settings
from app.consul import Registration

ADDRESS = "10.0.0.7"


class FakeConsul:
    """Agent API of Consul with a list of entries; stops the registration loop after `checks` own-entry checks."""

    def __init__(self, entries, checks=1, health_status=200, transport_errors=0, refused=()):
        self.entries = {e["ID"]: e for e in entries}
        self.refused = set(refused)  # deregistrations answered with 403
        self.checks, self.health_status, self.transport_errors = checks, health_status, transport_errors
        self.requests: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.requests.append(f"{request.method} {path}")
        if path == f"/v1/health/service/{SERVICE_NAME}":
            if self.transport_errors:
                self.transport_errors -= 1
                raise httpx.ConnectError("no route", request=request)
            if self.health_status != 200:
                return httpx.Response(self.health_status, text="boom")
            return httpx.Response(200, json=[{"Node": {"Address": "consul"}, "Service": e}
                                             for e in self.entries.values()])
        if path.startswith("/v1/agent/service/deregister/"):
            if path.rsplit("/", 1)[1] in self.refused:
                return httpx.Response(403, text="service entry not found")
            self.entries.pop(path.rsplit("/", 1)[1], None)
            return httpx.Response(200)
        if path == "/v1/agent/service/register":
            body = httpx.Response(200, content=request.content).json()
            self.entries[body["ID"]] = {k: body[k] for k in ("ID", "Address", "Port")}
            return httpx.Response(200)
        if path.startswith("/v1/agent/service/"):
            if self.checks == 0:
                raise asyncio.CancelledError  # ends keep_registered() after the wanted number of loops
            self.checks -= 1
            entry = self.entries.get(path.rsplit("/", 1)[1])
            return httpx.Response(404) if entry is None else httpx.Response(200, json=entry)
        return httpx.Response(404)


def run_registration(fake: FakeConsul, monkeypatch) -> Settings:
    real_sleep = asyncio.sleep
    monkeypatch.setattr(consul_module.asyncio, "sleep", lambda _: real_sleep(0))
    settings = Settings(service_address=ADDRESS, instance_id=f"{SERVICE_NAME}-new")

    async def ready():
        return True

    async def main():
        async with httpx.AsyncClient(base_url="http://consul", transport=httpx.MockTransport(fake)) as client:
            with pytest.raises(asyncio.CancelledError):
                await Registration(client, settings, ready).keep_registered()

    asyncio.run(main())
    return settings


def entry(service_id, address=ADDRESS, port=None):
    return {"ID": service_id, "Address": address, "Port": port or Settings().port}


def test_same_address_and_port_other_id_is_removed(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger=SERVICE_NAME)
    fake = FakeConsul([entry(f"{SERVICE_NAME}-old")])
    settings = run_registration(fake, monkeypatch)
    assert list(fake.entries) == [settings.instance_id]
    removed = [r for r in caplog.records if r.getMessage() == "Removed an orphaned entry from Consul"]
    assert [r.fields["removedId"] for r in removed] == [f"{SERVICE_NAME}-old"]


def test_refused_orphan_does_not_stop_the_cleanup(monkeypatch, caplog):
    # Two orphans, the first deregistration refused (403, e.g. reaped meanwhile): the second is still removed.
    caplog.set_level(logging.INFO, logger=SERVICE_NAME)
    fake = FakeConsul([entry(f"{SERVICE_NAME}-old"), entry(f"{SERVICE_NAME}-old-2")], refused={f"{SERVICE_NAME}-old"})
    settings = run_registration(fake, monkeypatch)
    assert sorted(fake.entries) == sorted([f"{SERVICE_NAME}-old", settings.instance_id])
    removed = [r.fields["removedId"] for r in caplog.records if r.getMessage() == "Removed an orphaned entry from Consul"]
    assert removed == [f"{SERVICE_NAME}-old-2"]
    warning, = [r for r in caplog.records if r.levelname == "WARNING"]
    assert warning.fields == {"reason": "HTTPStatusError", "failed": 1}


def test_other_address_or_other_port_is_left_alone(monkeypatch):
    others = [entry("other-address", address="10.0.0.8"), entry("other-port", port=9999)]
    fake = FakeConsul(others)
    settings = run_registration(fake, monkeypatch)
    assert sorted(fake.entries) == sorted(["other-address", "other-port", settings.instance_id])
    assert not [r for r in fake.requests if "deregister" in r]


@pytest.mark.parametrize("address", [ADDRESS, "10.0.0.9"])
def test_own_id_is_deregistered_then_registered(monkeypatch, caplog, address):
    # Z5: an entry with our own ID (same container restarted, same or new IP) keeps its old check state when
    # registered again, so it is removed first; the cleanup of orphans does not touch it.
    caplog.set_level(logging.INFO, logger=SERVICE_NAME)
    own = f"{SERVICE_NAME}-new"
    fake = FakeConsul([entry(own, address=address)])
    run_registration(fake, monkeypatch)
    writes = [r for r in fake.requests if r.startswith("PUT")]
    assert writes == [f"PUT /v1/agent/service/deregister/{own}", "PUT /v1/agent/service/register"]
    assert fake.entries[own]["Address"] == ADDRESS
    assert [r.getMessage() for r in caplog.records if "previous process" in r.getMessage()] == [
        "Removed the Consul entry of the previous process"]


def test_no_own_entry_registers_without_deregistration(monkeypatch):
    fake = FakeConsul([])
    settings = run_registration(fake, monkeypatch)
    assert [r for r in fake.requests if r.startswith("PUT")] == ["PUT /v1/agent/service/register"]
    assert list(fake.entries) == [settings.instance_id]


def test_cleanup_error_still_registers(monkeypatch, caplog):
    fake = FakeConsul([entry(f"{SERVICE_NAME}-old")], health_status=500)
    settings = run_registration(fake, monkeypatch)
    assert settings.instance_id in fake.entries
    assert [r.levelname for r in caplog.records if "Orphaned" in r.getMessage()] == ["WARNING"]


def test_no_connection_retries_the_cleanup_on_first_contact(monkeypatch, caplog):
    fake = FakeConsul([entry(f"{SERVICE_NAME}-old")], transport_errors=2)
    settings = run_registration(fake, monkeypatch)
    assert list(fake.entries) == [settings.instance_id]
    assert fake.requests.count(f"GET /v1/health/service/{SERVICE_NAME}") == 3
    assert not [r for r in caplog.records if "Orphaned" in r.getMessage()]


def test_later_checks_do_not_clean_up(monkeypatch):
    fake = FakeConsul([], checks=3)
    run_registration(fake, monkeypatch)
    assert fake.requests.count(f"GET /v1/health/service/{SERVICE_NAME}") == 1
    assert fake.requests.count(f"GET /v1/agent/service/{SERVICE_NAME}-new") == 4
