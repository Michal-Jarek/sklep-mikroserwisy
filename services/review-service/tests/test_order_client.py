import httpx
import pytest

from app.config import Settings
from app.order_client import OrderClient, OrderServiceUnavailable


def make_client(handler, **kwargs):
    settings = Settings(consul_enabled=False, order_service_url="http://order:8086")
    return OrderClient(settings, transport=httpx.MockTransport(handler), retry_wait_max=0.01, **kwargs)


def test_purchased_true_and_query_params():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        return httpx.Response(200, json={"purchased": True})

    client = make_client(handler)
    assert client.has_purchased("u1", 7, {"Authorization": "Bearer t"}) is True
    assert seen["url"].startswith("http://order:8086/orders/purchased")
    assert "userId=u1" in seen["url"] and "productId=7" in seen["url"]
    assert seen["auth"] == "Bearer t"


def test_purchased_false_and_bare_boolean_are_supported():
    assert make_client(lambda r: httpx.Response(200, json={"purchased": False})).has_purchased("u", 1) is False
    assert make_client(lambda r: httpx.Response(200, json=True)).has_purchased("u", 1) is True


def test_server_errors_are_retried_twice_then_fail():
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(503)

    with pytest.raises(OrderServiceUnavailable):
        make_client(handler).has_purchased("u", 1)
    assert len(calls) == 3  # 1 próba + 2 ponowienia


def test_transient_error_then_success():
    responses = iter([httpx.Response(500), httpx.Response(200, json={"purchased": True})])
    assert make_client(lambda r: next(responses)).has_purchased("u", 1) is True


def test_client_errors_are_not_retried():
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(403)

    with pytest.raises(OrderServiceUnavailable):
        make_client(handler).has_purchased("u", 1)
    assert len(calls) == 1


def test_network_error_is_unavailable():
    def handler(request):
        raise httpx.ConnectTimeout("timeout")

    with pytest.raises(OrderServiceUnavailable):
        make_client(handler).has_purchased("u", 1)


def test_circuit_breaker_opens_after_repeated_failures():
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(500)

    client = make_client(handler)
    for _ in range(6):
        with pytest.raises(OrderServiceUnavailable):
            client.has_purchased("u", 1)
    calls_before = len(calls)
    with pytest.raises(OrderServiceUnavailable):
        client.has_purchased("u", 1)
    assert len(calls) == calls_before  # obwód otwarty: Order nie jest już wołany
