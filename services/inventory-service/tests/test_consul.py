import asyncio
import json

import httpx

from app.config import Settings
from app.consul_registration import ConsulRegistrar


class FakeConsul:
    """Udaje agenta Consula: pamięta wpis instancji i zapisuje wywołania."""

    def __init__(self, fail_registers: int = 0):
        self.entry = None
        self.calls = []
        self.register_calls = 0
        self.fail_registers = fail_registers

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.calls.append((request.method, path))
        if request.method == "PUT" and path.endswith("/register"):
            self.register_calls += 1
            if self.fail_registers > 0:
                self.fail_registers -= 1
                raise httpx.ConnectError("consul down")
            body = json.loads(request.content)
            self.entry = {"Address": body["Address"], "Port": body["Port"]}
            return httpx.Response(200)
        if request.method == "PUT" and "/deregister/" in path:
            self.entry = None
            return httpx.Response(200)
        if request.method == "GET":
            return httpx.Response(404) if self.entry is None else httpx.Response(200, json=self.entry)
        return httpx.Response(500)


def run_registrar(fake: FakeConsul, before_stop=None, seconds=0.3):
    async def scenario():
        registrar = ConsulRegistrar(
            Settings(service_address="10.0.0.1"),
            transport=httpx.MockTransport(fake.handler),
            check_interval=0.01,
            retry_initial=0.01,
            retry_max=0.02,
        )
        task = asyncio.create_task(registrar.run())
        await asyncio.sleep(seconds / 3)
        if before_stop:
            before_stop()
        await asyncio.sleep(seconds)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())


def test_registers_once_and_deregisters_on_stop():
    fake = FakeConsul()
    run_registrar(fake)
    assert fake.register_calls == 1
    assert fake.calls[-1][0] == "PUT" and "/deregister/" in fake.calls[-1][1]


def test_registers_again_when_consul_forgot_the_instance():
    fake = FakeConsul()
    run_registrar(fake, before_stop=lambda: setattr(fake, "entry", None))
    assert fake.register_calls == 2


def test_registers_again_when_the_address_changed():
    fake = FakeConsul()
    run_registrar(fake, before_stop=lambda: setattr(fake, "entry", {"Address": "10.9.9.9", "Port": 8084}))
    assert fake.register_calls == 2


def test_registration_is_retried_while_consul_is_down():
    fake = FakeConsul(fail_registers=2)
    run_registrar(fake)
    assert fake.register_calls == 3  # dwie nieudane próby i trzecia udana, potem już tylko sprawdzanie


def test_register_payload_has_unique_id_and_ready_check():
    captured = {}

    def handler(request):
        if request.url.path.endswith("/register"):
            captured.update(json.loads(request.content))
        return httpx.Response(404 if request.method == "GET" else 200)

    async def scenario():
        registrar = ConsulRegistrar(Settings(service_address="10.0.0.1", instance_id="inventory-service-abc"),
                                    transport=httpx.MockTransport(handler), check_interval=5, retry_initial=0.01)
        task = asyncio.create_task(registrar.run())
        await asyncio.sleep(0.1)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())
    assert captured["ID"] == "inventory-service-abc"
    assert captured["Name"] == "inventory-service"
    assert captured["Address"] == "10.0.0.1" and captured["Port"] == 8084
    assert captured["Check"]["HTTP"] == "http://10.0.0.1:8084/health/ready"
    assert captured["Check"]["Interval"] == "10s" and captured["Check"]["Timeout"] == "2s"
