import asyncio

import httpx

from app.config import Settings
from app.remote_config import load_log_level


def load(handler):
    return asyncio.run(load_log_level(Settings(), transport=httpx.MockTransport(handler)))


def test_reads_log_level_from_yaml_in_consul_kv():
    seen = {}

    def handler(request):
        seen["path"] = request.url.path
        seen["raw"] = request.url.params.get("raw")
        return httpx.Response(200, text="logLevel: debug\n")

    assert load(handler) == "debug"
    assert seen["path"] == "/v1/kv/config/inventory-service/data"
    assert seen["raw"] == "true"


def test_level_is_case_insensitive_and_json_is_valid_yaml():
    assert load(lambda r: httpx.Response(200, text="logLevel: WARNING")) == "warning"
    assert load(lambda r: httpx.Response(200, text='{"logLevel": "error"}')) == "error"


def test_missing_key_or_empty_value_means_defaults():
    assert load(lambda r: httpx.Response(404)) is None
    assert load(lambda r: httpx.Response(200, text="")) is None
    assert load(lambda r: httpx.Response(200, text="inneKlucze: 1")) is None


def test_invalid_values_are_ignored():
    assert load(lambda r: httpx.Response(200, text="logLevel: verbose")) is None
    assert load(lambda r: httpx.Response(200, text="logLevel: critical")) is None  # tylko debug, info, warning, error
    assert load(lambda r: httpx.Response(200, text="- lista")) is None  # nie mapa
    assert load(lambda r: httpx.Response(200, text="klucz: [niezamknięta")) is None  # zły YAML


def test_consul_down_does_not_block_startup():
    def handler(request):
        raise httpx.ConnectError("consul down")

    assert load(handler) is None
