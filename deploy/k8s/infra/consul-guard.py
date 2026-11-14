#!/usr/bin/env python3
"""consul-guard: allow-list proxy in front of the Consul HTTP API (Kubernetes only).

Why: whoever registers a service in Consul also defines its HTTP health check (URL, method,
headers, body), and the check is run by the Consul server, which can connect to every service.
A compromised pod could make Consul call any service with any X-User-* headers and bypass the
Gateway and the NetworkPolicy table. The Service `consul` points to this proxy, which passes to
`consul-server` only the calls our services make:

  GET /v1/kv/config/<name>/data           query: none, raw, raw=true
  GET /v1/health/service/<name>           query: none, passing, passing=true
  GET /v1/agent/service/<id>              no query
  PUT /v1/agent/service/register          no query; Address = the caller's IP, at most one plain
                                          HTTP check on its own /health/ready or /health/live;
                                          forwarded with "DisableRedirects": true in the check;
                                          an existing entry with this ID must have the caller's address
  PUT /v1/agent/service/deregister/<id>   no query; only an entry with the caller's address
  GET /guard/live, GET /guard/ready       own probes (ready = Consul has a leader)

Anything else gets 403. A new call or registration field used by a service = a new pattern here
plus a test in consul-guard_test.py. Standard library only (python:3.12-slim, script from a
ConfigMap).
"""

import http.client
import json
import logging
import os
import re
import signal
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LISTEN = ("0.0.0.0", 8500)  # noqa: S104 (pod IP; reachable only through NetworkPolicy)
UPSTREAM_TIMEOUT = 5.0  # seconds per Consul call; exceeded -> 504
READY_TIMEOUT = 2.0  # /guard/ready, below the readiness probe timeout (3 s)
CLIENT_TIMEOUT = 10.0  # slow or idle client connection
DRAIN_SECONDS = 10.0  # after SIGTERM: time for requests already started
MAX_BODY = 16 * 1024

SEGMENT = r"[A-Za-z0-9._-]{1,128}"
NAME = re.compile(SEGMENT)
ROUTES = (
    ("GET", re.compile(rf"/v1/kv/config/{SEGMENT}/data"), "kv"),
    ("GET", re.compile(rf"/v1/health/service/{SEGMENT}"), "health"),
    ("GET", re.compile(rf"/v1/agent/service/{SEGMENT}"), "service"),
    ("PUT", re.compile(r"/v1/agent/service/register"), "register"),
    ("PUT", re.compile(rf"/v1/agent/service/deregister/{SEGMENT}"), "deregister"),
    ("GET", re.compile(r"/guard/live"), "live"),
    ("GET", re.compile(r"/guard/ready"), "ready"),
)
# Exact query strings per route (None = no "?"); routes not listed accept no query.
QUERIES = {
    "kv": {None, "raw", "raw=true"},
    "health": {None, "passing", "passing=true"},
}

# Fields the 8 services send (Meta: Inventory and Review); one check, only as "Check".
REGISTRATION_FIELDS = {"ID", "Name", "Address", "Port", "Meta", "Check"}
# DisableRedirects is not accepted from the caller: the guard always sets it (with_redirects_disabled).
CHECK_FIELDS = {
    "Name", "CheckID", "HTTP", "Interval", "Timeout", "DeregisterCriticalServiceAfter", "Status", "Notes", "Method",
}
HEALTH_PATHS = ("/health/ready", "/health/live")
# Consul fields that may be named in a denial reason. Any other key is reported as "unknown",
# so no request content ends up in responses or logs.
KNOWN_FIELDS = REGISTRATION_FIELDS | CHECK_FIELDS | {
    "Tags", "Checks", "Header", "Body", "TLSSkipVerify", "TLSServerName", "TCP", "TCPUseTLS", "GRPC", "GRPCUseTLS",
    "UDP", "H2PING", "H2PingUseTLS", "Args", "ScriptArgs", "Shell", "DockerContainerID", "OSService",
    "AliasNode", "AliasService", "TTL", "Kind", "Proxy", "Connect", "TaggedAddresses", "Weights",
    "EnableTagOverride", "SocketPath", "DisableRedirects", "Namespace", "Partition", "Locality",
}

FORWARDED_HEADERS = ("X-Consul-Token", "Content-Type", "Accept")
HEADER_VALUE = re.compile(r"[\x20-\x7e]*")
HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
    "te", "trailer", "trailers", "transfer-encoding", "upgrade", "content-length",
}

logger = logging.getLogger("consul-guard")


def valid_name(value: object) -> bool:
    return isinstance(value, str) and NAME.fullmatch(value) is not None and ".." not in value and value != "."


def check_request(method: str, target: str) -> tuple[str | None, str]:
    """Route of an allowed request, or (None, reason). `target` is the request target as received."""
    path, has_query, query = target.partition("?")
    if not path.isascii() or not path.isprintable():
        return None, "non-ASCII or control character in path"
    for fragment, reason in (("%", "percent-encoding in path"), ("\\", "backslash in path"),
                             ("#", "fragment in path"), ("//", "empty path segment")):
        if fragment in path:
            return None, reason
    if ".." in path or "/./" in path or path.endswith("/."):
        return None, "dot segment in path"
    route = None
    path_known = False
    for allowed_method, pattern, name in ROUTES:
        if pattern.fullmatch(path):
            path_known = True
            if method == allowed_method:
                route = name
                break
    if route is None:
        return None, "method not allowed" if path_known else "path not allowed"
    if (query if has_query else None) not in QUERIES.get(route, {None}):
        return None, "query not allowed"
    return route, "allowed"


def _object_without_duplicates(pairs: list) -> dict:
    keys = [key for key, _ in pairs]
    if len(keys) != len(set(keys)):
        raise ValueError("duplicate key")
    return dict(pairs)


def _reject_constant(name: str) -> None:
    raise ValueError(name)


def _field(key: object) -> str:
    return key if key in KNOWN_FIELDS else "unknown"


def validate_registration(body: bytes, client_ip: str) -> tuple[bool, str]:
    """Body of PUT /v1/agent/service/register: the caller registers itself with at most one plain
    HTTP check on its own address. Returns (allowed, reason)."""
    if len(body) > MAX_BODY:
        return False, "body too large"
    try:
        data = json.loads(body, object_pairs_hook=_object_without_duplicates, parse_constant=_reject_constant)
    except (ValueError, RecursionError):
        return False, "body is not valid JSON (or has duplicate keys)"
    if not isinstance(data, dict):
        return False, "body is not a JSON object"
    for key in data:
        if key not in REGISTRATION_FIELDS:
            return False, f"registration field not allowed: {_field(key)}"
    if data.get("Address") != client_ip:
        return False, "address is not the caller's address"
    port = data.get("Port")
    if type(port) is not int or not 1 <= port <= 65535:
        return False, "port must be an integer 1-65535"
    if not valid_name(data.get("Name")):
        return False, "invalid service name"
    if "ID" in data and not valid_name(data["ID"]):
        return False, "invalid service id"
    meta = data.get("Meta", {})
    if not isinstance(meta, dict) or not all(isinstance(value, str) for value in meta.values()):
        return False, "meta must map strings to strings"
    if "Check" in data:
        return _validate_check(data["Check"], f"http://{client_ip}:{port}")
    return True, "allowed"


def _validate_check(check: object, own_origin: str) -> tuple[bool, str]:
    if not isinstance(check, dict):
        return False, "check must be an object"
    for key, value in check.items():
        if key not in CHECK_FIELDS:
            return False, f"check field not allowed: {_field(key)}"
        if not isinstance(value, str):
            return False, f"check field must be a string: {key}"
    if check.get("Method", "GET") != "GET":
        return False, "check method must be GET"
    if check.get("HTTP") not in [own_origin + path for path in HEALTH_PATHS]:
        return False, "check URL must be http://<own address>:<port>/health/ready or /health/live"
    # Default check IDs are "service:<id>"; a custom one must not reach another service's check.
    if "CheckID" in check and not valid_name(check["CheckID"]):
        return False, "invalid check id"
    return True, "allowed"


def with_redirects_disabled(body: bytes) -> bytes:
    """A validated registration with "DisableRedirects": true added to its check, otherwise unchanged.

    Consul follows redirects of HTTP checks by default: a pod answering its own /health/ready with
    302 would make the Consul server send GETs to any address it can reach (tested on Consul 1.21).
    """
    data = json.loads(body)
    if "Check" in data:
        data["Check"]["DisableRedirects"] = True
    return json.dumps(data, separators=(",", ":")).encode()


def consul_request(upstream: tuple[str, int], method: str, target: str, headers: dict,
                   body: bytes | None, timeout: float) -> tuple[int, str, list, bytes]:
    """One call to Consul on a new connection; returns (status, reason, headers, body)."""
    connection = http.client.HTTPConnection(upstream[0], upstream[1], timeout=timeout)
    try:
        # Only the allowed headers: no Accept-Encoding (Consul answers uncompressed), Host = upstream.
        connection.putrequest(method, target, skip_accept_encoding=True)
        for name, value in headers.items():
            connection.putheader(name, value)
        if body is not None or method == "PUT":
            connection.putheader("Content-Length", str(len(body or b"")))
        connection.endheaders(body)
        response = connection.getresponse()
        return response.status, response.reason, response.getheaders(), response.read()
    finally:
        connection.close()


class Rejected(Exception):
    def __init__(self, status: int, reason: str):
        super().__init__(reason)
        self.status = status
        self.reason = reason


class GuardHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = CLIENT_TIMEOUT

    def log_message(self, format, *args):
        """Off: the default access log prints the query (it may carry a token). See log_event."""

    def __getattr__(self, name):
        # Every method (also DELETE, POST or unknown ones) goes through the allow-list, not a 501.
        if name.startswith("do_"):
            return self.handle_request
        raise AttributeError(name)

    def handle_request(self):
        with self.server.idle:
            self.server.active += 1
        try:
            self.process()
        except Rejected as rejected:
            self.refuse(rejected.status, rejected.reason)
        finally:
            with self.server.idle:
                self.server.active -= 1
                self.server.idle.notify_all()

    def process(self):
        route, reason = check_request(self.command, self.path)
        if route is None:
            raise Rejected(403, reason)
        body = self.read_body(route == "register")
        if route == "live":
            return self.reply(200, "ok")
        if route == "ready":
            return self.ready()
        headers = {}
        for name in FORWARDED_HEADERS:
            value = self.headers.get(name)
            if value is not None:
                if not HEADER_VALUE.fullmatch(value):
                    raise Rejected(400, "invalid header value")
                headers[name] = value
        if route == "register":
            allowed, reason = validate_registration(body, self.client_address[0])
            if not allowed:
                raise Rejected(403, reason)
            # Consul uses Name as the ID when there is none.
            data = json.loads(body)
            self.check_owner(data.get("ID", data["Name"]), headers.get("X-Consul-Token"), missing_ok=True)
            body = with_redirects_disabled(body)
        elif route == "deregister":
            self.check_owner(self.path.rsplit("/", 1)[1], headers.get("X-Consul-Token"), missing_ok=False)
        status, phrase, response_headers, response_body = self.consul(self.command, self.path, headers, body)
        if route in ("register", "deregister"):
            self.log_event(logging.INFO, "request forwarded", "allow", "allowed", status=status)
        self.send_response_only(status, phrase or None)
        for name, value in response_headers:
            if name.lower() not in HOP_BY_HOP:
                self.send_header(name, value)
        self.send_header("Content-Length", str(len(response_body)))
        if self.close_connection or self.server.draining:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(response_body)

    def read_body(self, expected: bool) -> bytes | None:
        """Body of a register call (Content-Length required); other calls must not have one."""
        if self.headers.get_all("Transfer-Encoding"):
            raise Rejected(411 if expected else 400, "transfer-encoding not allowed")
        lengths = self.headers.get_all("Content-Length") or []
        if len(lengths) > 1 or (lengths and not re.fullmatch(r"[0-9]{1,9}", lengths[0])):
            raise Rejected(400, "invalid content-length")
        length = int(lengths[0]) if lengths else None
        if not expected:
            if length:
                raise Rejected(400, "request body not allowed")
            return None
        if length is None:
            raise Rejected(411, "content-length required")
        if length > MAX_BODY:
            raise Rejected(413, "body too large")
        body = self.rfile.read(length)
        if len(body) != length:
            raise Rejected(400, "incomplete body")
        return body

    def check_owner(self, service_id: str, token: str | None, missing_ok: bool):
        """The entry `service_id` must have the caller's address: deregistration only of the caller's own entry,
        registration never replaces the entry of another pod. No entry: allowed only when `missing_ok`."""
        headers = {"X-Consul-Token": token} if token is not None else {}
        status, _, _, data = self.consul("GET", f"/v1/agent/service/{service_id}", headers, None)
        if status == 404:
            if missing_ok:
                return
            raise Rejected(403, "service entry not found")
        if status == 403:
            raise Rejected(403, "service entry lookup denied by Consul")
        if status != 200:
            raise Rejected(502, f"service entry lookup failed ({status})")
        try:
            address = json.loads(data).get("Address")
        except (ValueError, AttributeError):
            raise Rejected(502, "service entry lookup returned invalid JSON") from None
        if address != self.client_address[0]:
            raise Rejected(403, "service entry has another address")

    def consul(self, method: str, target: str, headers: dict, body: bytes | None) -> tuple[int, str, list, bytes]:
        try:
            return consul_request(self.server.upstream, method, target, headers, body, UPSTREAM_TIMEOUT)
        except TimeoutError:
            raise Rejected(504, "consul timeout") from None
        except (OSError, http.client.HTTPException) as exc:
            raise Rejected(502, f"consul unreachable ({type(exc).__name__})") from None

    def ready(self):
        try:
            status, _, _, body = consul_request(
                self.server.upstream, "GET", "/v1/status/leader", {}, None, READY_TIMEOUT)
            leader = json.loads(body) if status == 200 else ""
        except TimeoutError:
            raise Rejected(503, "consul timeout") from None
        except (OSError, http.client.HTTPException, ValueError) as exc:
            raise Rejected(503, f"consul unreachable ({type(exc).__name__})") from None
        if not isinstance(leader, str) or not leader:
            raise Rejected(503, "consul has no leader")
        self.reply(200, "ok")

    def refuse(self, status: int, reason: str):
        if status >= 500:
            self.log_event(logging.ERROR, "consul error", "error", reason)
        else:
            self.log_event(logging.WARNING, "request denied", "deny", reason)
        # The request body may be unread, so the connection is not reused.
        self.close_connection = True
        self.reply(status, f"consul-guard: {reason}")

    def reply(self, status: int, text: str):
        body = (text + "\n").encode()
        self.send_response_only(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if self.close_connection or self.server.draining:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def log_event(self, level: int, message: str, decision: str, reason: str, **fields):
        # Never the query, headers or body: the query may carry a token, the body is the client's data.
        logger.log(level, message, extra={"fields": {
            "method": self.command[:16],
            "path": self.path.partition("?")[0][:200],
            "client": self.client_address[0],
            "decision": decision,
            "reason": reason,
            **fields,
        }})


class GuardServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128  # default 5 drops connections when many pods reconnect at once

    def __init__(self, address: tuple[str, int], upstream: tuple[str, int]):
        super().__init__(address, GuardHandler)
        self.upstream = upstream
        self.draining = False
        self.active = 0
        self.idle = threading.Condition()

    def handle_error(self, request, client_address):
        # The default prints a traceback to stderr; an exception message may carry request data.
        logger.error("unhandled error", extra={"fields": {
            "client": client_address[0], "decision": "error", "reason": type(sys.exc_info()[1]).__name__}})

    def wait_idle(self, seconds: float) -> int:
        """Waits until no request is in progress (at most `seconds`); returns how many are left."""
        deadline = time.monotonic() + seconds
        with self.idle:
            while self.active and deadline > time.monotonic():
                self.idle.wait(deadline - time.monotonic())
            return self.active


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "time": datetime.fromtimestamp(record.created, timezone.utc).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "service": "consul-guard",
            "message": record.getMessage(),
        }
        entry.update(getattr(record, "fields", {}))
        return json.dumps(entry)


def parse_upstream(value: str) -> tuple[str, int]:
    host, _, port = value.rpartition(":")
    if not host or not port.isdigit():
        raise SystemExit(f"CONSUL_UPSTREAM must be host:port, got {value!r}")
    return host, int(port)


def main() -> int:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False

    upstream = parse_upstream(os.environ.get("CONSUL_UPSTREAM", "consul-server:8500"))
    server = GuardServer(LISTEN, upstream)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.5}, daemon=True).start()
    logger.info("consul-guard started", extra={"fields": {
        "listen": f"{LISTEN[0]}:{LISTEN[1]}", "upstream": f"{upstream[0]}:{upstream[1]}"}})

    while not stop.wait(1):
        pass
    server.draining = True
    logger.info("consul-guard stopping")
    server.shutdown()  # serve_forever returns: no new connections are accepted
    server.server_close()
    unfinished = server.wait_idle(DRAIN_SECONDS)
    logger.info("consul-guard stopped", extra={"fields": {"unfinished": unfinished}})
    return 0


if __name__ == "__main__":
    sys.exit(main())
