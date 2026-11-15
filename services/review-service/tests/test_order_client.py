import time

import httpx
import pytest

from app.circuit_breaker import CircuitBreaker
from app.config import Settings
from app.discovery import ServiceNotFound
from app.order_client import OrderClient, OrderServiceUnavailable

USER = "5c9d1a7e-3b2f-4e8a-b6d4-1f0e9a8c7b65"
PRODUCT = "3f0c9b1e-6a52-4a8e-9c1f-0b2f7e1d5a77"
HEADERS = {"X-Request-Id": "r-1", "X-User-Id": USER, "X-User-Roles": "CUSTOMER,SERVICE"}


def make_client(handler, **kwargs):
    settings = Settings(consul_enabled=False, order_service_url="http://order:8086")
    kwargs.setdefault("retry_wait", 0.001)
    return OrderClient(settings, transport=httpx.MockTransport(handler), **kwargs)


def ask(client):
    return client.has_purchased(USER, PRODUCT, HEADERS)


def test_purchased_true_with_query_params_and_headers():
    seen = {}

    def handler(request):
        seen["request"] = request
        return httpx.Response(200, json={"purchased": True})

    assert ask(make_client(handler)) is True
    request = seen["request"]
    assert str(request.url).startswith("http://order:8086/orders/purchased")
    assert request.url.params["userId"] == USER and request.url.params["productId"] == PRODUCT
    assert request.headers["X-User-Id"] == USER
    assert request.headers["X-User-Roles"] == "CUSTOMER,SERVICE"
    assert request.headers["X-Request-Id"] == "r-1"
    assert "authorization" not in request.headers


def test_purchased_false():
    assert ask(make_client(lambda r: httpx.Response(200, json={"purchased": False}))) is False


@pytest.mark.parametrize("body", [True, {"purchased": "yes"}, {}, [1]])
def test_response_outside_the_contract_is_unavailable_without_retry(body):
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(200, json=body)

    with pytest.raises(OrderServiceUnavailable):
        ask(make_client(handler))
    assert len(calls) == 1


@pytest.mark.parametrize("status", [502, 503, 504])
def test_gateway_errors_are_retried_twice_then_fail(status):
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(status)

    with pytest.raises(OrderServiceUnavailable):
        ask(make_client(handler))
    assert len(calls) == 3  # 1 próba + 2 ponowienia


@pytest.mark.parametrize("status", [500, 408, 429, 400, 401, 403, 404, 409])
def test_other_errors_are_not_retried(status):
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(status)

    with pytest.raises(OrderServiceUnavailable):
        ask(make_client(handler))
    assert len(calls) == 1


def test_transient_error_then_success():
    responses = iter([httpx.Response(503), httpx.Response(200, json={"purchased": True})])
    assert ask(make_client(lambda r: next(responses))) is True


@pytest.mark.parametrize("exc", [httpx.ConnectError("refused"), httpx.ReadTimeout("timeout")])
def test_network_errors_are_retried_then_unavailable(exc):
    calls = []

    def handler(request):
        calls.append(1)
        raise exc

    with pytest.raises(OrderServiceUnavailable):
        ask(make_client(handler))
    assert len(calls) == 3


def test_retry_waits_grow_200_then_400_ms():
    stamps = []

    def handler(request):
        stamps.append(time.monotonic())
        return httpx.Response(503)

    with pytest.raises(OrderServiceUnavailable):
        ask(make_client(handler, retry_wait=0.2))
    gaps = [b - a for a, b in zip(stamps, stamps[1:])]
    assert 0.18 <= gaps[0] < 0.35 and 0.38 <= gaps[1] < 0.6


def test_no_instances_means_unavailable_without_a_call():
    class NoInstances:
        def resolve(self, name, fallback_url=""):
            raise ServiceNotFound(name)

    calls = []
    client = OrderClient(Settings(), resolver=NoInstances(), transport=httpx.MockTransport(lambda r: calls.append(1)))
    with pytest.raises(OrderServiceUnavailable):
        ask(client)
    assert calls == []


def test_forbidden_answers_do_not_open_the_breaker():
    # K7: 5 × 403 od Order, a szóste wywołanie dalej dochodzi do Order
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(403) if len(calls) <= 5 else httpx.Response(200, json={"purchased": True})

    breaker = CircuitBreaker()
    client = make_client(handler, breaker=breaker)
    for _ in range(5):
        with pytest.raises(OrderServiceUnavailable):
            ask(client)
    assert ask(client) is True
    assert len(calls) == 6 and not breaker.is_open


def test_breaker_opens_after_failures_and_stops_calling_order():
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(500)  # awaria bez ponowień

    breaker = CircuitBreaker()
    client = make_client(handler, breaker=breaker)
    for _ in range(10):
        with pytest.raises(OrderServiceUnavailable):
            ask(client)
    assert breaker.is_open and len(calls) == 10
    with pytest.raises(OrderServiceUnavailable):
        ask(client)
    assert len(calls) == 10  # wyłącznik otwarty: Order nie jest wołany


def test_open_breaker_is_not_retried():
    now = [0.0]
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(503)

    breaker = CircuitBreaker(clock=lambda: now[0])
    client = make_client(handler, breaker=breaker)
    # 4 wywołania × 3 próby = 12 awarii: wyłącznik otwiera się na 10. próbie (4. wywołanie, 1. próba)
    for _ in range(4):
        with pytest.raises(OrderServiceUnavailable):
            ask(client)
    assert breaker.is_open and len(calls) == 10
