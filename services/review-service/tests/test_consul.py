import asyncio
import json
import logging
import socket

import httpx
import pytest

from app import db
from app.config import Settings
from app.consul_registration import ConsulRegistrar


OWN_ID = Settings().effective_instance_id
PORT = Settings().service_port
HEALTH_PATH = f"/v1/health/service/{Settings().service_name}"


class FakeConsul:
    """Udaje agenta Consula: pamięta wpis instancji i zapisuje wywołania."""

    def __init__(self, fail_registers: int = 0, others=None, health_response=None, fail_health: int = 0,
                 deregister_errors=None):
        self.entry = None
        self.calls = []
        self.register_calls = 0
        self.fail_registers = fail_registers
        self.others = list(others or [])  # inne wpisy tej usługi: {"ID", "Address", "Port"}
        self.health_response = health_response  # podmieniona odpowiedź /v1/health/service (błąd sprzątania)
        self.fail_health = fail_health
        self.deregister_errors = dict(deregister_errors or {})  # ID -> odpowiedź albo wyjątek (jednorazowo)

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
            removed = path.rsplit("/", 1)[1]
            error = self.deregister_errors.pop(removed, None)
            if isinstance(error, Exception):
                raise error
            if error is not None:
                return error
            if removed == OWN_ID:
                self.entry = None
            self.others = [o for o in self.others if o["ID"] != removed]
            return httpx.Response(200)
        if request.method == "GET" and path.startswith("/v1/health/service/"):
            if self.fail_health > 0:
                self.fail_health -= 1
                raise httpx.ConnectError("consul down")
            if self.health_response is not None:
                return self.health_response
            own = [] if self.entry is None else [{"ID": OWN_ID, **self.entry}]
            return httpx.Response(200, json=[{"Service": service} for service in own + self.others])
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
    run_registrar(fake, before_stop=lambda: setattr(fake, "entry", {"Address": "10.9.9.9", "Port": 8088}))
    assert fake.register_calls == 2


def test_entry_left_by_a_killed_process_is_replaced_at_start():
    # wpis po zabitym poprzednim procesie (to samo ID i IP) ma stary stan checku, który Consul zachowałby
    # przy samej ponownej rejestracji, więc nowy proces najpierw go usuwa
    fake = FakeConsul()
    fake.entry = {"Address": "10.0.0.1", "Port": 8088}
    run_registrar(fake)
    puts = [path for method, path in fake.calls if method == "PUT"]
    assert "/deregister/" in puts[0] and puts[1].endswith("/register")
    assert fake.register_calls == 1


def test_no_deregistration_at_start_when_there_is_no_entry():
    fake = FakeConsul()
    run_registrar(fake)
    puts = [path for method, path in fake.calls if method == "PUT"]
    assert puts[0].endswith("/register") and sum("/deregister/" in p for p in puts) == 1  # tylko przy zatrzymaniu


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
        registrar = ConsulRegistrar(Settings(service_address="10.0.0.1", instance_id="review-service-abc"),
                                    transport=httpx.MockTransport(handler), check_interval=5, retry_initial=0.01)
        task = asyncio.create_task(registrar.run())
        await asyncio.sleep(0.1)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())
    assert captured["ID"] == "review-service-abc"
    assert captured["Name"] == "review-service"
    assert captured["Address"] == "10.0.0.1" and captured["Port"] == 8088
    assert captured["Check"]["HTTP"] == "http://10.0.0.1:8088/health/ready"
    assert captured["Check"]["Interval"] == "10s" and captured["Check"]["Timeout"] == "2s"
    assert captured["Check"]["Status"] in ("passing", "critical")


@pytest.mark.parametrize("ping_works, expected", [(True, "passing"), (False, "critical")])
def test_initial_check_status_follows_the_database(monkeypatch, ping_works, expected):
    def ping():
        if not ping_works:
            raise RuntimeError("db down")

    monkeypatch.setattr(db, "ping", ping)
    registrar = ConsulRegistrar(Settings(service_address="10.0.0.1"))
    assert asyncio.run(registrar._initial_status()) == expected


def test_instance_id_is_used_as_is_or_built_from_hostname():
    assert Settings(instance_id="review-service-7d9f-abcde").effective_instance_id == "review-service-7d9f-abcde"
    assert Settings(instance_id="").effective_instance_id == f"review-service-{socket.gethostname()}"


# --- Z7: osierocone wpisy (ten sam adres i port, inne ID) usuwane przy pierwszej rejestracji ---------------

def deregistered(fake):
    return [path.rsplit("/", 1)[1] for method, path in fake.calls if method == "PUT" and "/deregister/" in path]


def test_orphan_with_same_address_and_port_is_removed_before_registration(caplog):
    fake = FakeConsul(others=[{"ID": "old-container", "Address": "10.0.0.1", "Port": PORT}])
    with caplog.at_level(logging.INFO, logger="app"):
        run_registrar(fake)
    assert deregistered(fake)[0] == "old-container"
    puts = [path for method, path in fake.calls if method == "PUT"]
    assert puts.index("/v1/agent/service/deregister/old-container") < puts.index("/v1/agent/service/register")
    assert fake.others == [] and fake.register_calls == 1
    removed = [r for r in caplog.records if r.getMessage() == "Usunięto osierocony wpis z Consula"]
    assert len(removed) == 1 and removed[0].fields == {"removedId": "old-container"}


@pytest.mark.parametrize("other", [
    {"ID": "other-address", "Address": "10.0.0.2", "Port": PORT},
    {"ID": "other-port", "Address": "10.0.0.1", "Port": PORT + 1},
])
def test_entry_with_other_address_or_port_is_left_alone(other):
    fake = FakeConsul(others=[other])
    run_registrar(fake)
    assert other["ID"] not in deregistered(fake)
    assert fake.others == [other] and fake.register_calls == 1


def test_own_entry_goes_through_z5_path_and_orphan_is_removed_too():
    fake = FakeConsul(others=[{"ID": "old-container", "Address": "10.0.0.1", "Port": PORT}])
    fake.entry = {"Address": "10.0.0.1", "Port": PORT}
    run_registrar(fake)
    # przy starcie: sierota, potem własny wpis (Z5), potem rejestracja; ostatni deregister to zatrzymanie
    assert deregistered(fake) == ["old-container", OWN_ID, OWN_ID]
    assert fake.register_calls == 1


@pytest.mark.parametrize("response", [httpx.Response(500), httpx.Response(200, text="nie json"),
                                      httpx.Response(200, json={"bez": "listy"})])
def test_cleanup_error_logs_one_warning_and_registration_still_happens(response, caplog):
    fake = FakeConsul(health_response=response)
    with caplog.at_level(logging.INFO, logger="app"):
        run_registrar(fake)
    assert fake.register_calls == 1
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert [r.getMessage() for r in warnings] == ["Nie udało się usunąć osieroconych wpisów z Consula, rejestruję dalej"]


def test_consul_down_at_start_cleanup_runs_at_first_successful_contact():
    fake = FakeConsul(fail_health=2, others=[{"ID": "old-container", "Address": "10.0.0.1", "Port": PORT}])
    run_registrar(fake)
    assert deregistered(fake)[0] == "old-container" and fake.register_calls == 1


def test_cleanup_only_at_start_not_in_periodic_checks():
    fake = FakeConsul()
    run_registrar(fake)  # check_interval 0,01 s: kilkanaście sprawdzeń okresowych
    assert sum(path == HEALTH_PATH for _, path in fake.calls) == 1
    assert sum(method == "GET" and path != HEALTH_PATH for method, path in fake.calls) > 5


# --- CR-34: odmowa przy jednej sierocie nie przerywa pętli ---------------------------------------

def test_refused_orphan_does_not_stop_the_loop_and_gives_one_warning(caplog):
    fake = FakeConsul(
        others=[{"ID": "old-1", "Address": "10.0.0.1", "Port": PORT}, {"ID": "old-2", "Address": "10.0.0.1", "Port": PORT}],
        deregister_errors={"old-1": httpx.Response(403, text="service entry not found")},
    )
    with caplog.at_level(logging.INFO, logger="app"):
        run_registrar(fake)
    assert deregistered(fake)[:2] == ["old-1", "old-2"]
    assert [o["ID"] for o in fake.others] == ["old-1"] and fake.register_calls == 1
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1 and warnings[0].fields == {"reason": "HTTP 403", "failed": 1}
    removed = [r.fields["removedId"] for r in caplog.records if r.getMessage() == "Usunięto osierocony wpis z Consula"]
    assert removed == ["old-2"]


def test_connection_error_while_removing_an_orphan_still_aborts_the_attempt():
    fake = FakeConsul(
        others=[{"ID": "old-1", "Address": "10.0.0.1", "Port": PORT}],
        deregister_errors={"old-1": httpx.ConnectError("consul down")},
    )
    run_registrar(fake)
    # pierwsza próba przerwana bez rejestracji, następna usuwa sierotę i rejestruje
    assert deregistered(fake)[:2] == ["old-1", "old-1"] and fake.others == [] and fake.register_calls == 1
