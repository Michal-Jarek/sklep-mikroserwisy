import json
import logging

from app.ids import valid_uuid
from app.logging_config import JsonFormatter, request_id_var, set_service_log_level, user_id_var

UUID = "0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e"


def make_record(msg="Request completed", exc_info=None, fields=None):
    record = logging.LogRecord("app.test", logging.INFO, __file__, 1, msg, (), exc_info)
    if fields:
        record.fields = fields
    return record


def test_log_line_has_the_team_fields():
    token_r, token_u = request_id_var.set("req-1"), user_id_var.set(UUID)
    try:
        line = json.loads(JsonFormatter("review-service").format(make_record(fields={"status": 200})))
    finally:
        request_id_var.reset(token_r)
        user_id_var.reset(token_u)
    assert line["level"] == "info" and line["service"] == "review-service"
    assert line["requestId"] == "req-1" and line["userId"] == UUID
    assert line["msg"] == "Request completed" and line["status"] == 200
    assert "time" in line


def test_exception_is_logged_without_its_message():
    try:
        raise ValueError("adres e-mail jan@example.com")
    except ValueError:
        import sys

        line = JsonFormatter("review-service").format(make_record(exc_info=sys.exc_info()))
    assert "jan@example.com" not in line
    data = json.loads(line)
    assert data["reason"] == "ValueError"
    assert data["stack"] and all(":" in frame for frame in data["stack"])


def test_log_level_applies_only_to_service_loggers():
    set_service_log_level("debug")
    assert logging.getLogger("app").level == logging.DEBUG
    assert logging.getLogger("uvicorn.error").level == logging.WARNING  # biblioteki zostają na ostrzeżeniach
    assert logging.getLogger().level == logging.WARNING
    set_service_log_level("nieznany")
    assert logging.getLogger("app").level == logging.INFO


def test_valid_uuid_helper():
    assert valid_uuid(UUID.upper()) == UUID
    assert valid_uuid("nie-uuid") is None
    assert valid_uuid(None) is None


def test_traceback_pasted_into_message_is_reduced_to_exception_class():
    # tak Starlette przekazuje uvicornowi błąd startu (lifespan.startup.failed): ślad z treścią wyjątku w komunikacie
    msg = (
        "Traceback (most recent call last):\n"
        '  File "/app/app/db.py", line 24, in init_client\n'
        "pymongo.errors.InvalidURI: Invalid URI scheme: 'mongodb//u:tajne@h/review_db'"
    )
    line = JsonFormatter("review-service").format(make_record(msg=msg))
    assert "tajne" not in line and "\n" not in line
    data = json.loads(line)
    assert data["reason"] == "InvalidURI"


def test_uvicorn_access_log_does_not_reach_the_root_logger():
    access = logging.getLogger("uvicorn.access")
    assert access.propagate is False and access.handlers == []


def test_empty_exc_info_adds_no_reason():
    line = json.loads(JsonFormatter("review-service").format(make_record(exc_info=(None, None, None))))
    assert "reason" not in line and "stack" not in line
