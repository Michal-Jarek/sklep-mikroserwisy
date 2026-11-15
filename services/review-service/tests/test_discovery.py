"""ServiceResolver: pusta lista `passing` z Consula (np. tuż po restarcie Consula) a ostatnia znana lista."""
import logging

import httpx
import pytest

from app import discovery
from app.config import Settings
from app.discovery import EMPTY_ANSWERS_MAX, ServiceNotFound, ServiceResolver

ORDER = [{"Service": {"Address": "10.0.0.7", "Port": 8086}, "Node": {"Address": "10.0.0.1"}}]


class FakeConsul:
    """Odpowiada listą ustawioną w `answer` (None = Consul nie działa); liczy zapytania."""

    def __init__(self):
        self.answer = ORDER
        self.calls = 0
        self.clock = None  # przy awarii przesuwa zegar o `error_delay` (zawieszony Consul: timeout 2 s)
        self.error_delay = 0.0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        assert request.url.params.get("passing") == "true"
        if self.answer is None:
            if self.clock is not None:
                self.clock[0] += self.error_delay
            raise httpx.ConnectError("connection refused", request=request)
        return httpx.Response(200, json=self.answer)


@pytest.fixture
def clock(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(discovery.time, "monotonic", lambda: now[0])
    return now


@pytest.fixture
def consul():
    return FakeConsul()


@pytest.fixture
def resolver(consul):
    return ServiceResolver(Settings(consul_enabled=True), ttl=10.0, transport=httpx.MockTransport(consul))


def warnings(caplog):
    return [r for r in caplog.records if r.name == "app.discovery" and r.levelno == logging.WARNING]


def test_empty_after_known_list_uses_last_list(resolver, consul, clock, caplog):
    assert resolver.resolve("order-service") == "http://10.0.0.7:8086"
    consul.answer = []
    clock[0] += 11  # cache 10 s minął, Consul po restarcie zwraca pustą listę
    caplog.set_level(logging.INFO, logger="app.discovery")
    assert resolver.resolve("order-service") == "http://10.0.0.7:8086"
    clock[0] += 1
    assert resolver.resolve("order-service") == "http://10.0.0.7:8086"
    assert consul.calls == 3  # pusta lista nie trafia do cache: każde wywołanie pyta Consula
    assert len(warnings(caplog)) == 1  # jedna linia na zmianę stanu, nie na każde wywołanie


def test_empty_answers_longer_than_limit_mean_not_found(resolver, consul, clock, caplog):
    resolver.resolve("order-service")
    consul.answer = []
    clock[0] += 11
    caplog.set_level(logging.INFO, logger="app.discovery")
    resolver.resolve("order-service")  # pierwsza pusta odpowiedź: początek serii, ostatnia znana lista
    clock[0] += EMPTY_ANSWERS_MAX + 0.1
    with pytest.raises(ServiceNotFound):
        resolver.resolve("order-service")
    assert len(warnings(caplog)) == 2  # stara lista, potem brak listy - po jednej linii na zmianę stanu


def test_empty_list_without_known_list_means_not_found(resolver, consul, clock):
    consul.answer = []
    with pytest.raises(ServiceNotFound):
        resolver.resolve("order-service")
    assert consul.calls == 1


def test_limit_counts_from_first_empty_answer(resolver, consul, clock):
    resolver.resolve("order-service")
    clock[0] += 25  # długo bez zapytań: wiek listy nie ma znaczenia
    consul.answer = []
    resolver.resolve("order-service")  # początek serii pustych
    clock[0] += 29.9
    assert resolver.resolve("order-service") == "http://10.0.0.7:8086"  # 54,9 s od niepustej, 29,9 s pustych
    clock[0] += 0.2
    with pytest.raises(ServiceNotFound):
        resolver.resolve("order-service")


def test_empty_after_long_consul_outage_uses_last_list(resolver, consul, clock):
    resolver.resolve("order-service")
    consul.answer = None  # Consul nie działa przez 60 s - lista się nie postarza
    for _ in range(6):
        clock[0] += 10
        assert resolver.resolve("order-service") == "http://10.0.0.7:8086"
    consul.answer = []  # po starcie Consul chwilę zwraca pustą listę
    clock[0] += 1
    assert resolver.resolve("order-service") == "http://10.0.0.7:8086"


def test_non_empty_answer_resets_the_empty_series(resolver, consul, clock):
    resolver.resolve("order-service")
    consul.answer = []
    clock[0] += 11
    resolver.resolve("order-service")  # seria 1
    clock[0] += 20
    consul.answer = ORDER
    resolver.resolve("order-service")  # niepusta zeruje licznik
    consul.answer = []
    clock[0] += 11
    resolver.resolve("order-service")  # seria 2 od nowa
    clock[0] += 20  # 40 s od początku serii 1, 20 s serii 2
    assert resolver.resolve("order-service") == "http://10.0.0.7:8086"


def test_back_to_normal_after_consul_returns_instances(resolver, consul, clock, caplog):
    resolver.resolve("order-service")
    consul.answer = []
    clock[0] += 11
    caplog.set_level(logging.INFO, logger="app.discovery")
    resolver.resolve("order-service")
    consul.answer = [{"Service": {"Address": "10.0.0.8", "Port": 8086}}]
    assert resolver.resolve("order-service") == "http://10.0.0.8:8086"
    infos = [r for r in caplog.records if r.name == "app.discovery" and r.levelno == logging.INFO]
    assert len(warnings(caplog)) == 1 and len(infos) == 1
    calls = consul.calls
    resolver.resolve("order-service")
    assert consul.calls == calls  # niepusta lista znów w cache


def test_consul_error_keeps_last_list_without_waiting_again(resolver, consul, clock):
    # CR-14: zawieszony Consul (każde zapytanie 2 s do timeoutu) - ponowienia wywołania Order i kolejne żądania
    # nie czekają znowu na Consula; termin cache liczony od chwili błędu
    resolver.resolve("order-service")
    consul.answer, consul.clock, consul.error_delay = None, clock, 2.0
    clock[0] += 11
    assert resolver.resolve("order-service") == "http://10.0.0.7:8086"  # 2 s czekania
    calls = consul.calls
    for step in (2.0 + 0.2, 2.0 + 0.4, 5.3):  # próba 2 i 3 po timeoucie Order, potem następne żądanie
        clock[0] += step
        assert resolver.resolve("order-service") == "http://10.0.0.7:8086"
    assert consul.calls == calls  # 9,9 s od błędu: bez zapytań do Consula
    clock[0] += 0.2
    resolver.resolve("order-service")
    assert consul.calls == calls + 1  # po TTL od błędu Consul pytany znowu
    consul.answer = ORDER
    clock[0] += 10.1
    resolver.resolve("order-service")
    assert consul.calls == calls + 2  # Consul wrócił: zwykła odpowiedź


def test_consul_error_logs_only_exception_class(resolver, consul, clock, caplog):
    resolver.resolve("order-service")
    consul.answer = None
    clock[0] += 11
    caplog.set_level(logging.INFO, logger="app.discovery")
    resolver.resolve("order-service")
    [record] = warnings(caplog)
    assert record.fields == {"reason": "ConnectError"}
    assert "connection refused" not in record.getMessage()


def test_consul_error_without_any_list_means_not_found(resolver, consul, clock):
    consul.answer = None
    with pytest.raises(ServiceNotFound):
        resolver.resolve("order-service")


def infos(caplog):
    return [r for r in caplog.records if r.name == "app.discovery" and r.levelno == logging.INFO]


def test_info_when_instances_return_after_last_list_was_dropped(resolver, consul, clock, caplog):
    # CR-37: wyjście z trybu ostatniej listy po wygaśnięciu 30 s też kończy się linią info
    resolver.resolve("order-service")
    consul.answer = []
    clock[0] += 11
    caplog.set_level(logging.INFO, logger="app.discovery")
    resolver.resolve("order-service")  # warning: ostatnia lista
    clock[0] += EMPTY_ANSWERS_MAX + 0.1
    with pytest.raises(ServiceNotFound):
        resolver.resolve("order-service")  # warning: brak listy
    consul.answer = ORDER
    resolver.resolve("order-service")
    assert len(warnings(caplog)) == 2 and len(infos(caplog)) == 1


def test_info_when_instances_return_after_consul_error_in_series(resolver, consul, clock, caplog):
    # CR-37: błąd Consula w trakcie serii pustych odpowiedzi nie gubi trybu - powrót niepustej listy daje info
    resolver.resolve("order-service")
    consul.answer = []
    clock[0] += 11
    caplog.set_level(logging.INFO, logger="app.discovery")
    resolver.resolve("order-service")  # warning: ostatnia lista
    consul.answer = None
    clock[0] += 1
    resolver.resolve("order-service")  # błąd Consula: warning z klasą wyjątku, lista na 10 s
    consul.answer = ORDER
    clock[0] += 10.1
    resolver.resolve("order-service")
    mode_warnings = [r for r in warnings(caplog) if "pustą listę" in r.getMessage()]
    assert len(mode_warnings) == 1 and len(infos(caplog)) == 1


def test_intermittent_consul_errors_do_not_restart_the_series(resolver, consul, clock):
    # CR-38 (scenariusz N1 z Gateway): pusta lista co 2 s, błąd Consula co 20 s. W Review błąd nie zaczyna serii od
    # nowa (inaczej niż Gateway i Order): do 30 s ostatnia lista, potem brak instancji; tylko 10 s po każdym błędzie
    # Consula wraca ostatnia lista (ścieżka błędu), więc może działać dłużej niż 30 s.
    resolver.resolve("order-service")
    clock[0] += 11
    start = clock[0]
    results = {}
    for t in range(0, 121, 2):
        clock[0] = start + t
        consul.answer = None if t and t % 20 == 0 else []
        try:
            results[t] = resolver.resolve("order-service")
        except ServiceNotFound:
            results[t] = None
    assert all(results[t] for t in range(0, 31, 2))  # pierwsze 30 s: ostatnia lista
    assert results[32] is None  # po 30 s od pierwszej pustej: brak instancji mimo błędu w t=20
    assert results[40] and results[48] and results[50] is None  # błąd w t=40: lista na 10 s, potem znów brak
