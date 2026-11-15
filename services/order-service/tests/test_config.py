"""Configuration and logs: DB_URL without the password in errors, instance ID (D13), JSON lines (D16)."""
import asyncio
import json
import logging
import os
import socket
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from app import database
from app.config import Settings
from app.logging_config import JsonFormatter
from app.main import create_app
from tests.conftest import BODY, Dependencies, settings


@pytest.mark.parametrize("url", ["postgresql+psycopg//order_service:e8t2-secret-x@postgres/order_db",
                                 "postgresql+psycopg://order_service:e8t2-secret-x@postgres:54x32/order_db",
                                 "postgresq+psycopg://order_service:e8t2-secret-x@postgres/order_db"])
def test_invalid_db_url_hides_the_password(url):
    with pytest.raises(RuntimeError) as error:
        create_app(Settings(db_url=url, consul_enabled=False, broker_enabled=False))
    assert "e8t2-secret-x" not in str(error.value) and error.value.__suppress_context__
    assert error.value.__cause__ is None


def test_instance_id():
    assert Settings().effective_instance_id == f"order-service-{socket.gethostname()}"
    assert Settings(instance_id="order-service-7d9f-abc").effective_instance_id == "order-service-7d9f-abc"


def test_rabbitmq_variables(monkeypatch):
    for name, value in {"RABBITMQ_HOST": "rabbitmq", "RABBITMQ_PORT": "5673", "RABBITMQ_USER": "order-service",
                        "RABBITMQ_PASSWORD": "test-only", "ORDER_DB_PASSWORD": "db-test-only"}.items():
        monkeypatch.setenv(name, value)
    config = Settings()
    assert (config.rabbitmq_host, config.rabbitmq_port, config.rabbitmq_user) == ("rabbitmq", 5673, "order-service")
    assert config.rabbitmq_password == "test-only" and config.database_url.password == "db-test-only"


def test_json_logs_with_request_id_and_no_card(tmp_path, capsys):
    deps = Dependencies(str(uuid4()), str(uuid4()))
    deps.rules["inventory:POST"] = {"status": 400}  # error line of S6
    app = create_app(settings(tmp_path))
    with TestClient(app) as client:
        app.state.peers.client = httpx.AsyncClient(transport=httpx.MockTransport(deps))
        headers = {"X-User-Id": deps.customer, "X-User-Roles": "CUSTOMER", "X-Request-Id": "e8t2-log-1"}
        assert client.post("/orders", headers=headers, json=BODY).status_code == 503
        assert client.get("/health/live", headers={"X-Request-Id": "bad id"}).status_code == 200
    lines = [line for line in capsys.readouterr().out.splitlines() if line.strip()]
    entries = [json.loads(line) for line in lines]  # every line is JSON
    assert all({"time", "level", "service", "requestId", "userId", "msg"} <= e.keys() for e in entries)
    mine = [e for e in entries if e["requestId"] == "e8t2-log-1"]
    assert {"error", "warning", "info"} <= {e["level"] for e in mine}
    error = next(e for e in mine if e["level"] == "error")
    assert error["target"] == "inventory" and error["status"] == 400 and error["userId"] == deps.customer
    assert all(e["service"] == "order-service" for e in entries)
    assert BODY["payment"]["cardNumber"] not in "".join(lines)
    assert BODY["shippingAddress"]["street"] not in "".join(lines)
    access = [e for e in entries if e["msg"] == "HTTP request" and e["path"] == "/health/live"]
    assert len(access) == 1 and access[0]["requestId"] != "bad id"


def test_unhandled_error_is_500_with_a_log_line(tmp_path, capsys):
    app = create_app(settings(tmp_path))

    @app.get("/boom")
    async def boom():
        raise KeyError("secret detail")

    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get("/boom", headers={"X-Request-Id": "e8t2-boom"})
    assert response.status_code == 500 and response.json()["requestId"] == "e8t2-boom"
    out = capsys.readouterr().out
    [line] = [json.loads(x) for x in out.splitlines() if '"Unhandled error"' in x]
    assert line["reason"] == "KeyError" and line["requestId"] == "e8t2-boom" and "secret detail" not in out


@pytest.mark.parametrize("url", ["postgresql+psycopg//order_service:e8t2-secret-x@postgres/order_db",
                                 "postgresql+psycopg://order_service:e8t2-secret-x@postgres:54x32/order_db"])
def test_invalid_db_url_at_start_is_one_json_line(url):
    """uvicorn imports app.main: instead of a traceback (63 lines, not JSON) one error line and exit code 1."""
    env = {**os.environ, "DB_URL": url, "CONSUL_ENABLED": "false", "BROKER_ENABLED": "false"}
    result = subprocess.run([sys.executable, "-m", "uvicorn", "app.main:app", "--port", "0"], env=env, timeout=60,
                            cwd=Path(__file__).parents[1], capture_output=True, text=True)
    lines = (result.stdout + result.stderr).splitlines()
    assert result.returncode == 1 and len(lines) == 1, lines
    line = json.loads(lines[0])
    assert line["level"] == "error" and line["reason"] == "ConfigError"
    assert line["msg"] == "Startup failed: DB_URL has an invalid format (value not shown)"
    assert "e8t2-secret-x" not in lines[0] and "postgres" not in lines[0]


def test_traceback_text_in_a_message_keeps_only_the_class():
    """Starlette passes a failed startup to uvicorn as traceback text (it may quote the address and password)."""
    text = ("Traceback (most recent call last):\n  File \"/srv/app/main.py\", line 1, in lifespan\n"
            "sqlalchemy.exc.OperationalError: connection to server at \"db-x\" failed for e8t2-secret-x\n")
    for message, expected in ((text, "Unhandled exception"), ("Startup failed\n" + text, "Startup failed")):
        record = logging.LogRecord("uvicorn.error", logging.ERROR, __file__, 1, message, None, None)
        line = json.loads(JsonFormatter("order-service").format(record))
        assert line["msg"] == expected and line["reason"] == "OperationalError"
        assert "e8t2-secret-x" not in json.dumps(line) and "db-x" not in json.dumps(line)
    plain = logging.LogRecord("app", logging.INFO, __file__, 1, "plain message", None, None)
    assert "reason" not in json.loads(JsonFormatter("order-service").format(plain))


def test_unreachable_database_at_start_warns_once_per_30_s(monkeypatch, caplog):
    """A wrong host in DB_URL: the service keeps waiting (the database may start later), one warning per 15 tries."""
    attempts = []

    def create_schema(engine):
        attempts.append(1)
        if len(attempts) <= 31:
            raise ConnectionError("db-x e8t2-secret-x")

    monkeypatch.setattr(database, "create_schema", create_schema)
    monkeypatch.setattr(database, "SCHEMA_RETRY_SECONDS", 0)
    caplog.set_level(logging.WARNING, logger="app")
    asyncio.run(database.wait_for_schema(None))
    warnings = [r for r in caplog.records if r.name == "app.database"]
    assert len(attempts) == 32 and len(warnings) == 3
    assert all(r.fields == {"reason": "ConnectionError"} for r in warnings)


def test_postgres_connections_notice_a_vanished_server(monkeypatch):
    """CR-13: keepalives and tcp_user_timeout next to connect_timeout (a database cut off from the network gives an error
    after ~5 s instead of a connection hanging for minutes); SQLite keeps its own arguments."""
    from app import database
    captured, real = [], database.create_engine

    def recording(url, **kwargs):
        captured.append(kwargs["connect_args"])
        return real(url, **kwargs)
    monkeypatch.setattr(database, "create_engine", recording)
    database.make_engine(Settings(db_url="postgresql+psycopg://order_service:e8t2-unused@db.invalid/order_db"))
    database.make_engine(Settings(db_url="sqlite:////tmp/order-cr13.db"))
    assert captured == [
        {"connect_timeout": 2, "keepalives": 1, "keepalives_idle": 5, "keepalives_interval": 2, "keepalives_count": 2,
         "tcp_user_timeout": 5000},
        {"check_same_thread": False}]
