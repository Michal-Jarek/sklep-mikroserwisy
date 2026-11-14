"""Tests of consul-guard.py (unittest, standard library only).

Run: docker run --rm -v "$R/deploy/k8s/infra:/src:ro" -w /src python:3.12-slim python -I consul-guard_test.py -v
"""

import http.client
import importlib.util
import json
import logging
import pathlib
import socket
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_spec = importlib.util.spec_from_file_location("consul_guard", pathlib.Path(__file__).with_name("consul-guard.py"))
guard = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(guard)

IP = "10.42.0.17"
TOKEN = "3f1c0d6e-0000-4000-8000-guard-test-token"  # noqa: S105 (fake value for log checks)


def check(port, status=None):
    body = {"HTTP": f"http://{IP}:{port}/health/ready", "Interval": "10s", "Timeout": "2s",
            "DeregisterCriticalServiceAfter": "1m"}
    if status:
        body["Status"] = status
    return body


# Registration bodies as the 8 services build them (Address = the pod IP):
# Gateway/Auth   src/consul/consul-registration.service.ts registrationBody()  (Status first)
# User/Cart      app/discovery.py Discovery.register()
# Product/Notif. app/consul.py Registration.register()                          (Status last)
# Inventory/Rev. app/consul_registration.py ConsulRegistrar._payload()           (Meta)
SERVICES = {
    "api-gateway": {"ID": "api-gateway-6d9c7b5f4-x2kqp", "Name": "api-gateway", "Address": IP, "Port": 8080,
                    "Check": {"Status": "passing", **check(8080)}},
    "auth-service": {"ID": "auth-service-7f8d9c6b5-q7w2e", "Name": "auth-service", "Address": IP, "Port": 8081,
                     "Check": {"Status": "critical", **check(8081)}},
    "user-service": {"ID": "user-service-5c6d7e8f9-abcde", "Name": "user-service", "Address": IP, "Port": 8082,
                     "Check": check(8082)},
    "cart-service": {"ID": "cart-service-5c6d7e8f9-fghij", "Name": "cart-service", "Address": IP, "Port": 8085,
                     "Check": check(8085)},
    "product-service": {"ID": "product-service-64f5d-k2l3m", "Name": "product-service", "Address": IP,
                        "Port": 8083, "Check": check(8083, "passing")},
    "notification-service": {"ID": "notification-service-5b-n4o5p", "Name": "notification-service",
                             "Address": IP, "Port": 8087, "Check": check(8087, "critical")},
    "inventory-service": {"ID": "inventory-service-inventory-service-7d8-r6s7t", "Name": "inventory-service",
                          "Address": IP, "Port": 8084,
                          "Meta": {"instance_id": "inventory-service-7d8-r6s7t"}, "Check": check(8084)},
    "review-service": {"ID": "review-service-review-service-6c7-u8v9w", "Name": "review-service",
                       "Address": IP, "Port": 8088,
                       "Meta": {"instance_id": "review-service-6c7-u8v9w"}, "Check": check(8088)},
}


def cart(**changes):
    body = json.loads(json.dumps(SERVICES["cart-service"]))
    check_changes = changes.pop("check", {})
    body.update(changes)
    body["Check"].update(check_changes)
    return body


def validate(body, client_ip=IP):
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    return guard.validate_registration(raw, client_ip)


class RegistrationAllowed(unittest.TestCase):
    def test_all_eight_services(self):
        for name, body in SERVICES.items():
            with self.subTest(service=name):
                # JSON.stringify (Node) and httpx write compact JSON; json.dumps default spacing too.
                for raw in (json.dumps(body, separators=(",", ":")).encode(), json.dumps(body).encode()):
                    self.assertEqual(guard.validate_registration(raw, IP), (True, "allowed"))

    def test_live_check_optional_check_fields_and_no_check(self):
        self.assertTrue(validate(cart(check={"HTTP": f"http://{IP}:8085/health/live", "Method": "GET"}))[0])
        self.assertTrue(validate(cart(check={"Name": "ready", "Notes": "n", "CheckID": "cart-ready"}))[0])
        without = cart()
        del without["Check"]
        self.assertTrue(validate(without)[0])


class RegistrationDenied(unittest.TestCase):
    def assertDenied(self, body, reason_part, client_ip=IP):
        allowed, reason = validate(body, client_ip)
        self.assertFalse(allowed)
        self.assertIn(reason_part, reason)

    def test_foreign_address(self):
        self.assertDenied(cart(Address="10.42.0.99"), "address")
        self.assertDenied(cart(), "address", client_ip="10.42.0.99")
        missing = cart()
        del missing["Address"]
        self.assertDenied(missing, "address")

    def test_check_header(self):
        self.assertDenied(cart(check={"Header": {"X-User-Roles": ["SERVICE"]}}), "check field not allowed: Header")

    def test_check_method_delete(self):
        self.assertDenied(cart(check={"Method": "DELETE"}), "check method must be GET")

    def test_check_body(self):
        self.assertDenied(cart(check={"Body": "{}"}), "check field not allowed: Body")

    def test_foreign_check_url(self):
        for url in ("http://10.42.0.99:8085/health/ready",  # another host
                    "http://user-service:8082/health/ready",
                    f"http://{IP}:8082/health/ready",  # another port
                    f"http://{IP}:8085/cart/u-123",  # another path
                    f"http://{IP}:8085/health/ready?x=1",
                    f"http://{IP}:8085/health/ready/../../cart",
                    f"https://{IP}:8085/health/ready",
                    f"http://{IP}:8085@10.42.0.99/health/ready"):
            with self.subTest(url=url):
                self.assertDenied(cart(check={"HTTP": url}), "check URL")
        no_url = cart()
        del no_url["Check"]["HTTP"]
        self.assertDenied(no_url, "check URL")

    def test_checks_and_tags_not_used_by_services(self):
        # One check, only as "Check": a second one (Checks) or a list in Checks is denied.
        self.assertDenied(cart(Checks=[check(8085)]), "registration field not allowed: Checks")
        single = cart()
        single["Checks"] = [single.pop("Check")]
        self.assertDenied(single, "registration field not allowed: Checks")
        self.assertDenied(cart(Tags=["v1"]), "registration field not allowed: Tags")

    def test_tcp_args_and_other_check_types(self):
        for field in ("TCP", "Args", "ScriptArgs", "GRPC", "UDP", "H2PING", "TTL", "DockerContainerID",
                      "OSService", "AliasService", "TLSSkipVerify", "DisableRedirects"):
            with self.subTest(field=field):
                self.assertDenied(cart(check={field: "x"}), f"check field not allowed: {field}")

    def test_kind_proxy_connect_tagged_addresses(self):
        for field, value in (("Kind", "connect-proxy"), ("Proxy", {}), ("Connect", {"Native": True}),
                             ("TaggedAddresses", {"lan": {"Address": IP, "Port": 1}}), ("Weights", {})):
            with self.subTest(field=field):
                self.assertDenied(cart(**{field: value}), f"registration field not allowed: {field}")

    def test_unknown_field_is_not_echoed(self):
        allowed, reason = validate(cart(**{"secret-value-abc": 1}))
        self.assertFalse(allowed)
        self.assertEqual(reason, "registration field not allowed: unknown")
        allowed, reason = validate(cart(check={"X-Consul-Token-xyz": "1"}))
        self.assertEqual(reason, "check field not allowed: unknown")

    def test_lowercase_keys(self):
        # Consul matches JSON keys case-insensitively; only the exact names are allowed here.
        self.assertDenied(cart(address="10.42.0.99"), "registration field not allowed")
        self.assertDenied(cart(check={"header": {"A": ["b"]}}), "check field not allowed")

    def test_bad_port(self):
        for port in (0, 70000, -1, "8085", 8085.0, True, None):
            with self.subTest(port=port):
                self.assertDenied(cart(Port=port), "port")

    def test_bad_name_and_id(self):
        for name in ("cart/service", "", "..", "a" * 129, "cart service", "café", None, 1):
            with self.subTest(name=name):
                self.assertDenied(cart(Name=name), "invalid service name")
        self.assertDenied(cart(ID="../x"), "invalid service id")
        self.assertDenied(cart(check={"CheckID": "service:user-service-1"}), "invalid check id")

    def test_bad_meta_and_check_types(self):
        self.assertDenied(cart(Meta={"a": 1}), "meta")
        self.assertDenied(cart(Meta=["a"]), "meta")
        self.assertDenied(cart(check={"Interval": 10}), "check field must be a string")
        no_object = cart()
        no_object["Check"] = None
        self.assertDenied(no_object, "check must be an object")

    def test_not_a_json_object(self):
        for raw in (b"", b"[]", b"null", b"{", b'{"Port": NaN}', b"\xff\xfe", b"[" * 100000):
            with self.subTest(raw=raw[:10]):
                self.assertFalse(guard.validate_registration(raw, IP)[0])

    def test_duplicate_keys(self):
        raw = json.dumps(cart())[:-1] + ', "Address": "10.42.0.99"}'
        self.assertDenied(raw.encode(), "duplicate keys")

    def test_body_too_large(self):
        self.assertDenied(cart(Meta={"x": "a" * guard.MAX_BODY}), "body too large")


class RedirectsDisabled(unittest.TestCase):
    def test_check_gets_disable_redirects(self):
        for name, body in SERVICES.items():
            with self.subTest(service=name):
                forwarded = json.loads(guard.with_redirects_disabled(json.dumps(body).encode()))
                expected = json.loads(json.dumps(body))
                expected["Check"]["DisableRedirects"] = True
                self.assertEqual(forwarded, expected)

    def test_no_check(self):
        without = cart()
        del without["Check"]
        self.assertEqual(json.loads(guard.with_redirects_disabled(json.dumps(without).encode())), without)

    def test_caller_cannot_set_disable_redirects(self):
        # Set only by the guard; no service sends it, so any value from the caller is denied.
        for value in (False, True):
            with self.subTest(value=value):
                allowed, reason = validate(cart(check={"DisableRedirects": value}))
                self.assertEqual((allowed, reason), (False, "check field not allowed: DisableRedirects"))


class Paths(unittest.TestCase):
    ALLOWED = [
        ("GET", "/v1/kv/config/api-gateway/data?raw", "kv"),
        ("GET", "/v1/kv/config/cart-service/data?raw=true", "kv"),
        ("GET", "/v1/kv/config/cart-service/data", "kv"),
        ("GET", "/v1/health/service/auth-service?passing", "health"),
        ("GET", "/v1/health/service/product-service?passing=true", "health"),
        ("GET", "/v1/health/service/product-service", "health"),
        ("GET", "/v1/agent/service/api-gateway-6d9c7b5f4-x2kqp", "service"),
        ("PUT", "/v1/agent/service/register", "register"),
        ("PUT", "/v1/agent/service/deregister/inventory-service-inventory-service-7d8-r6s7t", "deregister"),
        ("GET", "/guard/live", "live"),
        ("GET", "/guard/ready", "ready"),
    ]

    def assertDenied(self, method, target, reason_part=""):
        route, reason = guard.check_request(method, target)
        self.assertIsNone(route, f"{method} {target}")
        self.assertIn(reason_part, reason)

    def test_allowed_patterns(self):
        for method, target, route in self.ALLOWED:
            with self.subTest(target=target):
                self.assertEqual(guard.check_request(method, target), (route, "allowed"))

    def test_kv_and_agent_writes(self):
        self.assertDenied("PUT", "/v1/kv/config/x/data", "method not allowed")
        self.assertDenied("DELETE", "/v1/kv/config/x/data", "method not allowed")
        self.assertDenied("DELETE", "/v1/kv/config/x/data?recurse", "method not allowed")
        self.assertDenied("PUT", "/v1/kv/other/key", "path not allowed")
        self.assertDenied("GET", "/v1/kv/config/x/other", "path not allowed")
        self.assertDenied("GET", "/v1/kv/?recurse", "path not allowed")

    def test_check_and_catalog_registration(self):
        self.assertDenied("PUT", "/v1/agent/check/register", "path not allowed")
        self.assertDenied("PUT", "/v1/agent/check/deregister/service:x", "path not allowed")
        self.assertDenied("PUT", "/v1/catalog/register", "path not allowed")
        self.assertDenied("POST", "/v1/catalog/register", "path not allowed")
        self.assertDenied("PUT", "/v1/catalog/deregister", "path not allowed")

    def test_register_with_other_method(self):
        for method in ("POST", "GET", "DELETE", "PATCH", "HEAD", "put"):
            with self.subTest(method=method):
                route, _ = guard.check_request(method, "/v1/agent/service/register")
                # GET /v1/agent/service/register reads an entry named "register" (no effect).
                self.assertNotEqual(route, "register")

    def test_maintenance(self):
        self.assertDenied("PUT", "/v1/agent/service/maintenance/cart-service-1?enable=true", "path not allowed")
        self.assertDenied("PUT", "/v1/agent/service/maintenance/cart-service-1", "path not allowed")
        self.assertDenied("PUT", "/v1/agent/maintenance?enable=true", "path not allowed")

    def test_other_api(self):
        for method, target in (
            ("GET", "/v1/acl/policies"), ("PUT", "/v1/acl/policy"), ("GET", "/v1/acl/token/self"),
            ("GET", "/v1/agent/monitor"), ("GET", "/v1/agent/metrics"), ("GET", "/v1/snapshot"),
            ("PUT", "/v1/event/fire/x"), ("PUT", "/v1/txn"), ("PUT", "/v1/agent/token/x"),
            ("PUT", "/v1/agent/reload"), ("PUT", "/v1/agent/join/10.0.0.1"), ("PUT", "/v1/agent/leave"),
            ("PUT", "/v1/agent/force-leave/x"), ("GET", "/v1/connect/ca/roots"),
            ("PUT", "/v1/operator/raft/peer"), ("GET", "/v1/catalog/services"), ("GET", "/v1/agent/services"),
            ("GET", "/v1/health/checks/cart-service"), ("GET", "/v1/status/leader"), ("GET", "/ui/"),
            ("GET", "/"), ("GET", "*"), ("GET", "http://consul:8500/v1/kv/config/x/data"),
        ):
            with self.subTest(target=target):
                self.assertDenied(method, target)

    def test_path_tricks(self):
        for target, reason in (
            ("/v1/agent/service/register/../../kv/x", "dot segment"),
            ("/v1//kv/x", "empty path segment"),
            ("/v1/agent/service/%72egister", "percent-encoding"),
            ("/V1/kv/config/x/data", "path not allowed"),
            ("/v1/KV/config/x/data", "path not allowed"),
            ("/v1/kv/config/x/data/../../acl", "dot segment"),
            ("/v1/kv/config/%2e%2e/data", "percent-encoding"),
            ("/v1/kv/config/%2E%2E/data", "percent-encoding"),
            ("/v1/health/service/a%2Fb", "percent-encoding"),
            ("/v1/kv/config/../data", "dot segment"),
            ("/v1/kv/config/./data", "dot segment"),
            ("/v1/agent/service/.", "dot segment"),
            ("/v1/kv/config/x\\..\\acl/data", "backslash"),
            ("/v1/kv/config/x/data#frag", "fragment"),
            ("/v1/kv/config/café/data", "non-ASCII"),
            ("/v1/kv/config/x\x00/data", "control character"),
            ("/v1/kv/config/x/data/", "path not allowed"),
            ("/v1/health/service/" + "a" * 129, "path not allowed"),
        ):
            with self.subTest(target=target):
                self.assertDenied("GET", target, reason)

    def test_query_tricks(self):
        for target in (
            "/v1/kv/config/x/data?raw&token=x", "/v1/kv/config/x/data?token=x", "/v1/kv/config/x/data?dc=x",
            "/v1/kv/config/x/data?ns=x", "/v1/kv/config/x/data?raw&raw", "/v1/kv/config/x/data?raw=1",
            "/v1/kv/config/x/data?", "/v1/kv/config/x/data?recurse", "/v1/kv/config/x/data?raw&",
            "/v1/health/service/x?passing&index=1", "/v1/health/service/x?passing=1",
            "/v1/health/service/x?wait=10s", "/v1/health/service/x?passing&passing",
            "/v1/health/service/x?filter=x", "/v1/health/service/x?PASSING",
            "/v1/agent/service/x?token=y", "/guard/live?x",
        ):
            with self.subTest(target=target):
                self.assertDenied("GET", target, "query not allowed")
        self.assertDenied("PUT", "/v1/agent/service/register?replace-existing-checks", "query not allowed")
        self.assertDenied("PUT", "/v1/agent/service/register?token=x", "query not allowed")
        self.assertDenied("PUT", "/v1/agent/service/deregister/x?token=y", "query not allowed")


class FakeConsul:
    """Consul stand-in: records every request; answers from `routes` (path without query)."""

    def __init__(self):
        self.requests = []
        self.routes = {}
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                pass

            def handle_any(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                fake.requests.append({"method": self.command, "path": self.path,
                                      "headers": dict(self.headers.items()), "body": body})
                path = self.path.partition("?")[0]
                # Without a route: no service entry (lookup of register/deregister), otherwise an empty object.
                missing = self.command == "GET" and path.startswith("/v1/agent/service/")
                status, headers, payload, delay = fake.routes.get(
                    (self.command, path), (404, {}, b"", 0) if missing else (200, {}, b"{}", 0))
                time.sleep(delay)
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            do_GET = do_PUT = handle_any

        class Server(ThreadingHTTPServer):
            daemon_threads = True

            def handle_error(self, request, client_address):
                pass  # the guard closed the connection after its timeout

        self.server = Server(("127.0.0.1", 0), Handler)
        self.address = self.server.server_address
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class ListHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.setFormatter(guard.JsonFormatter())
        self.lines = []

    def emit(self, record):
        self.lines.append(self.format(record))


class Proxy(unittest.TestCase):
    """The guard in-process on a random port in front of FakeConsul."""

    def setUp(self):
        self.fake = FakeConsul()
        self.guard = guard.GuardServer(("127.0.0.1", 0), self.fake.address)
        threading.Thread(target=self.guard.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        self.logs = ListHandler()
        guard.logger.addHandler(self.logs)
        guard.logger.setLevel(logging.INFO)
        guard.logger.propagate = False

    def tearDown(self):
        guard.logger.removeHandler(self.logs)
        self.guard.shutdown()
        self.guard.server_close()
        self.fake.close()

    def request(self, method, target, body=None, headers=None):
        connection = http.client.HTTPConnection(*self.guard.server_address, timeout=5)
        try:
            connection.request(method, target, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def raw(self, data):
        with socket.create_connection(self.guard.server_address, timeout=5) as sock:
            sock.sendall(data)
            chunks = []
            while chunk := sock.recv(65536):
                chunks.append(chunk)
        return b"".join(chunks)

    def own(self, **changes):
        body = cart(**changes)
        body["Address"] = "127.0.0.1"
        body["Check"]["HTTP"] = "http://127.0.0.1:8085/health/ready"
        return body

    def test_get_passes_query_and_allowed_headers_only(self):
        self.fake.routes[("GET", "/v1/kv/config/cart-service/data")] = (
            200, {"X-Consul-Index": "42", "Content-Type": "text/plain"}, b"logLevel: debug\n", 0)
        status, headers, body = self.request("GET", "/v1/kv/config/cart-service/data?raw=true", headers={
            "X-Consul-Token": TOKEN, "Accept": "*/*", "X-Request-Id": "r-1", "X-User-Id": "u-1",
            "X-User-Roles": "SERVICE", "Cookie": "a=b", "Authorization": "Bearer x", "X-Forwarded-For": "1.2.3.4"})
        self.assertEqual((status, body), (200, b"logLevel: debug\n"))
        self.assertEqual(headers["X-Consul-Index"], "42")
        self.assertEqual(headers["Content-Length"], "16")
        [seen] = self.fake.requests
        self.assertEqual((seen["method"], seen["path"]), ("GET", "/v1/kv/config/cart-service/data?raw=true"))
        self.assertEqual(seen["headers"]["X-Consul-Token"], TOKEN)
        self.assertEqual(seen["headers"]["Accept"], "*/*")
        self.assertEqual(seen["headers"]["Host"], f"127.0.0.1:{self.fake.address[1]}")
        self.assertEqual(set(seen["headers"]), {"Host", "X-Consul-Token", "Accept"})
        self.assertEqual(self.logs.lines, [], "plain GETs are not logged")

    def test_consul_status_and_body_one_to_one(self):
        self.fake.routes[("GET", "/v1/health/service/review-service")] = (
            404, {"X-Consul-Knownleader": "true"}, b"service not found", 0)
        status, headers, body = self.request("GET", "/v1/health/service/review-service?passing")
        self.assertEqual((status, body, headers["X-Consul-Knownleader"]), (404, b"service not found", "true"))
        self.fake.routes[("GET", "/v1/health/service/review-service")] = (500, {}, b"rpc error", 0)
        self.assertEqual(self.request("GET", "/v1/health/service/review-service")[::2], (500, b"rpc error"))

    def test_register_forwards_the_body_with_redirects_disabled(self):
        sent = self.own()
        raw = json.dumps(sent, separators=(",", ":")).encode()
        status, _, _ = self.request("PUT", "/v1/agent/service/register", body=raw, headers={
            "Content-Type": "application/json", "X-Consul-Token": TOKEN, "X-Request-Id": "r-2"})
        self.assertEqual(status, 200)
        lookup, seen = self.fake.requests
        self.assertEqual((lookup["method"], lookup["path"]), ("GET", "/v1/agent/service/cart-service-5c6d7e8f9-fghij"))
        self.assertEqual(lookup["headers"]["X-Consul-Token"], TOKEN)
        sent["Check"]["DisableRedirects"] = True
        self.assertEqual(json.loads(seen["body"]), sent)
        self.assertEqual(seen["headers"]["Content-Length"], str(len(seen["body"])))
        self.assertEqual(seen["path"], "/v1/agent/service/register")
        self.assertEqual(set(seen["headers"]), {"Host", "Content-Type", "X-Consul-Token", "Content-Length"})
        [line] = self.logs.lines
        entry = json.loads(line)
        self.assertEqual((entry["level"], entry["decision"], entry["status"]), ("info", "allow", 200))
        self.assertEqual(entry["service"], "consul-guard")

    def entry(self, service_id, address):
        self.fake.routes[("GET", f"/v1/agent/service/{service_id}")] = (
            200, {}, json.dumps({"ID": service_id, "Address": address, "Port": 8085}).encode(), 0)

    def test_register_does_not_replace_another_pods_entry(self):
        self.entry("cart-service-5c6d7e8f9-fghij", "10.42.0.99")
        status, _, body = self.request("PUT", "/v1/agent/service/register", body=json.dumps(self.own()).encode())
        self.assertEqual((status, body), (403, b"consul-guard: service entry has another address\n"))
        self.assertEqual([r["method"] for r in self.fake.requests], ["GET"])

    def test_register_again_with_own_address(self):
        self.entry("cart-service-5c6d7e8f9-fghij", "127.0.0.1")
        status, _, _ = self.request("PUT", "/v1/agent/service/register", body=json.dumps(self.own()).encode())
        self.assertEqual(status, 200)
        self.assertEqual([r["method"] for r in self.fake.requests], ["GET", "PUT"])

    def test_register_without_id_checks_the_name(self):
        # Consul uses Name as the ID: the entry "cart-service" of another pod must not be replaced.
        body = self.own()
        del body["ID"]
        self.entry("cart-service", "10.42.0.99")
        self.assertEqual(self.request("PUT", "/v1/agent/service/register", body=json.dumps(body).encode())[0], 403)
        self.entry("cart-service", "127.0.0.1")
        self.assertEqual(self.request("PUT", "/v1/agent/service/register", body=json.dumps(body).encode())[0], 200)
        self.assertEqual([r["path"] for r in self.fake.requests][-2], "/v1/agent/service/cart-service")

    def test_register_lookup_failure(self):
        self.fake.routes[("GET", "/v1/agent/service/cart-service-5c6d7e8f9-fghij")] = (500, {}, b"rpc error", 0)
        status, _, body = self.request("PUT", "/v1/agent/service/register", body=json.dumps(self.own()).encode())
        self.assertEqual((status, body), (502, b"consul-guard: service entry lookup failed (500)\n"))
        self.assertEqual([r["method"] for r in self.fake.requests], ["GET"])

    def test_register_denied_with_plain_text_reason(self):
        raw = json.dumps(self.own(check={"Header": {"X-User-Roles": ["SERVICE"]}})).encode()
        status, headers, body = self.request("PUT", "/v1/agent/service/register", body=raw)
        self.assertEqual(status, 403)
        self.assertTrue(headers["Content-Type"].startswith("text/plain"))
        self.assertEqual(body, b"consul-guard: check field not allowed: Header\n")
        self.assertEqual(self.fake.requests, [])
        entry = json.loads(self.logs.lines[0])
        self.assertEqual((entry["level"], entry["decision"]), ("warning", "deny"))

    def test_register_with_foreign_address(self):
        status, _, _ = self.request("PUT", "/v1/agent/service/register", body=json.dumps(cart()).encode())
        self.assertEqual(status, 403)
        self.assertEqual(self.fake.requests, [])

    def test_register_framing(self):
        reply = self.raw(b"PUT /v1/agent/service/register HTTP/1.1\r\nHost: consul\r\n\r\n")
        self.assertTrue(reply.startswith(b"HTTP/1.1 411 "), reply[:40])
        reply = self.raw(b"PUT /v1/agent/service/register HTTP/1.1\r\nHost: consul\r\n"
                         b"Transfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n")
        self.assertTrue(reply.startswith(b"HTTP/1.1 411 "), reply[:40])
        # Only the headers: the guard answers before reading a body (no reset by unread data).
        too_long = b"Content-Length: %d\r\n\r\n" % (guard.MAX_BODY + 1)
        reply = self.raw(b"PUT /v1/agent/service/register HTTP/1.1\r\n" + too_long)
        self.assertTrue(reply.startswith(b"HTTP/1.1 413 "), reply[:40])
        reply = self.raw(b"PUT /v1/agent/service/register HTTP/1.1\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\n{}")
        self.assertTrue(reply.startswith(b"HTTP/1.1 400 "), reply[:40])
        self.assertEqual(self.fake.requests, [])

    def test_body_on_bodyless_requests(self):
        reply = self.raw(b"GET /v1/kv/config/x/data HTTP/1.1\r\nContent-Length: 5\r\n\r\n")
        self.assertTrue(reply.startswith(b"HTTP/1.1 400 "), reply[:40])
        reply = self.raw(b"GET /v1/kv/config/x/data HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n")
        self.assertTrue(reply.startswith(b"HTTP/1.1 400 "), reply[:40])
        self.assertEqual(self.fake.requests, [])

    def test_deregister_own_entry(self):
        self.fake.routes[("GET", "/v1/agent/service/cart-service-1")] = (
            200, {}, json.dumps({"ID": "cart-service-1", "Address": "127.0.0.1", "Port": 8085}).encode(), 0)
        status, _, _ = self.request("PUT", "/v1/agent/service/deregister/cart-service-1",
                                    headers={"X-Consul-Token": TOKEN})
        self.assertEqual(status, 200)
        lookup, deregister = self.fake.requests
        self.assertEqual((lookup["method"], lookup["path"]), ("GET", "/v1/agent/service/cart-service-1"))
        self.assertEqual(lookup["headers"]["X-Consul-Token"], TOKEN)
        self.assertEqual((deregister["method"], deregister["path"]),
                         ("PUT", "/v1/agent/service/deregister/cart-service-1"))
        self.assertEqual(deregister["headers"]["Content-Length"], "0")

    def test_deregister_foreign_entry(self):
        self.fake.routes[("GET", "/v1/agent/service/user-service-1")] = (
            200, {}, json.dumps({"ID": "user-service-1", "Address": "10.42.0.99", "Port": 8082}).encode(), 0)
        status, _, body = self.request("PUT", "/v1/agent/service/deregister/user-service-1")
        self.assertEqual((status, body), (403, b"consul-guard: service entry has another address\n"))
        self.assertEqual([r["method"] for r in self.fake.requests], ["GET"])

    def test_deregister_missing_entry(self):
        self.fake.routes[("GET", "/v1/agent/service/gone-1")] = (404, {}, b"unknown service ID", 0)
        status, _, body = self.request("PUT", "/v1/agent/service/deregister/gone-1")
        self.assertEqual((status, body), (403, b"consul-guard: service entry not found\n"))
        self.assertEqual([r["method"] for r in self.fake.requests], ["GET"])

    def test_maintenance_denied(self):
        self.assertEqual(self.request("PUT", "/v1/agent/service/maintenance/cart-service-1?enable=true")[0], 403)
        self.assertEqual(self.fake.requests, [])

    def test_any_other_method_is_403(self):
        for method in ("DELETE", "POST", "PATCH", "OPTIONS", "FOO"):
            with self.subTest(method=method):
                self.assertEqual(self.request(method, "/v1/kv/config/x/data")[0], 403)
        self.assertEqual(self.fake.requests, [])

    def test_silent_consul_gives_504(self):
        self.fake.routes[("GET", "/v1/health/service/slow")] = (200, {}, b"[]", 1.0)
        original = guard.UPSTREAM_TIMEOUT
        guard.UPSTREAM_TIMEOUT = 0.3
        try:
            status, _, body = self.request("GET", "/v1/health/service/slow?passing")
        finally:
            guard.UPSTREAM_TIMEOUT = original
        self.assertEqual((status, body), (504, b"consul-guard: consul timeout\n"))
        entry = json.loads(self.logs.lines[-1])
        self.assertEqual((entry["level"], entry["decision"], entry["path"]),
                         ("error", "error", "/v1/health/service/slow"))

    def test_unreachable_consul_gives_502(self):
        with socket.socket() as unused:
            unused.bind(("127.0.0.1", 0))
            self.guard.upstream = unused.getsockname()  # bound, not listening: connection refused
            status, _, body = self.request("GET", "/v1/kv/config/x/data?raw")
            ready, _, _ = self.request("GET", "/guard/ready")
        self.assertEqual(status, 502)
        self.assertIn(b"consul unreachable", body)
        self.assertEqual(ready, 503)

    def test_probes(self):
        self.assertEqual(self.request("GET", "/guard/live")[::2], (200, b"ok\n"))
        self.fake.routes[("GET", "/v1/status/leader")] = (200, {}, b'"10.42.0.5:8300"', 0)
        self.assertEqual(self.request("GET", "/guard/ready")[::2], (200, b"ok\n"))
        self.fake.routes[("GET", "/v1/status/leader")] = (200, {}, b'""', 0)
        self.assertEqual(self.request("GET", "/guard/ready")[0], 503)
        self.fake.routes[("GET", "/v1/status/leader")] = (500, {}, b"boom", 0)
        self.assertEqual(self.request("GET", "/guard/ready")[0], 503)

    def test_keep_alive_for_allowed_requests(self):
        connection = http.client.HTTPConnection(*self.guard.server_address, timeout=5)
        try:
            for _ in range(3):
                connection.request("GET", "/v1/health/service/cart-service?passing")
                response = connection.getresponse()
                self.assertEqual((response.status, response.read()), (200, b"{}"))
        finally:
            connection.close()
        self.assertEqual(len(self.fake.requests), 3)

    def test_logs_without_tokens_query_or_body(self):
        secret_body = json.dumps(self.own(Meta={"note": "body-marker-123"})).encode()
        self.request("PUT", "/v1/agent/service/register", body=secret_body, headers={"X-Consul-Token": TOKEN})
        denied_body = json.dumps(self.own(check={"Body": "body-marker-456"})).encode()
        self.request("PUT", "/v1/agent/service/register", body=denied_body, headers={"X-Consul-Token": TOKEN})
        self.request("GET", f"/v1/kv/config/x/data?token={TOKEN}")
        self.request("GET", "/v1/acl/token/self", headers={"X-Consul-Token": TOKEN})
        self.assertEqual(len(self.logs.lines), 4)
        text = "\n".join(self.logs.lines)
        for forbidden in (TOKEN, "body-marker", "token=", "X-Consul-Token", '"ID"', '"Check"', "cart-service"):
            self.assertNotIn(forbidden, text)
        for line in self.logs.lines:
            entry = json.loads(line)
            self.assertEqual(set(entry) - {"status"},
                             {"time", "level", "service", "message", "method", "path", "client", "decision", "reason"})

    def test_drain_waits_for_started_requests(self):
        self.fake.routes[("GET", "/v1/health/service/slow")] = (200, {}, b"[]", 0.5)
        result = {}
        worker = threading.Thread(target=lambda: result.update(r=self.request("GET", "/v1/health/service/slow")))
        worker.start()
        time.sleep(0.2)
        self.guard.draining = True
        self.guard.shutdown()
        self.guard.server_close()
        self.assertEqual(self.guard.wait_idle(5), 0)
        worker.join()
        self.assertEqual(result["r"][0], 200)
        self.assertEqual(result["r"][1].get("Connection"), "close")
        with self.assertRaises(OSError):
            socket.create_connection(self.guard.server_address, timeout=1).close()


class Upstream(unittest.TestCase):
    def test_parse_upstream(self):
        self.assertEqual(guard.parse_upstream("consul-server:8500"), ("consul-server", 8500))
        for value in ("consul-server", ":8500", "consul-server:"):
            with self.subTest(value=value), self.assertRaises(SystemExit):
                guard.parse_upstream(value)


if __name__ == "__main__":
    unittest.main()
