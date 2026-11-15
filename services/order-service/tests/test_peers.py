"""Calls to other services (D2, D13, S7): circuit breaker, retries, last known list from Consul."""
import asyncio
import json
import logging
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest

from app.circuit_breaker import CircuitBreaker, CircuitOpen
from app.discovery import Discovery, NoInstances
from app.main import kv_log_level
from app.peers import Peers, Unavailable
from app.security import Caller

CALLER = Caller(uuid4(), frozenset({"CUSTOMER"}), "req-1")
NO_URLS = SimpleNamespace(shipping_service_url=None, cart_service_url=None, inventory_service_url=None,
                          product_service_url=None)


def consul_and_inventory(state):
    async def handle(request):
        if request.url.host == "consul":
            state["consul"] += 1
            state["queries"].append((request.url.path, request.url.query.decode()))
            if state["consul_down"]:
                raise httpx.ConnectError("consul down", request=request)
            if state.get("consul_empty"):
                return httpx.Response(200, json=[])  # e.g. just after a Consul restart, checks not run yet
            return httpx.Response(200, json=[{"Node": {"Address": "10.0.0.9"},
                                              "Service": {"Address": "10.0.0.5", "Port": 8084}}])
        state["inventory"].append(request)
        return httpx.Response(state.get("status", 200), json={})
    return handle


def make_peers(state) -> Peers:
    client = httpx.AsyncClient(transport=httpx.MockTransport(consul_and_inventory(state)))
    discovery = Discovery(client, "http://consul:8500", "order-service", "order-service-test", "10.0.0.2", 8086)
    return Peers(client, discovery, NO_URLS)


def fresh_state(**kwargs):
    return {"consul": 0, "consul_down": False, "inventory": [], "queries": [], **kwargs}


def unavailable_warnings(caplog):
    return [r.fields for r in caplog.records
            if r.name == "app.peers" and r.levelno == logging.WARNING and r.getMessage() == "Service unavailable"]


def test_consul_queries_are_exactly_what_consul_guard_allows():
    """consul-guard (deploy/k8s/infra/consul-guard.py) answers 403 to any other query string."""
    state = fresh_state()
    peers = make_peers(state)

    async def scenario():
        await peers.discovery.resolve("cart-service")
        await kv_log_level(peers.client, "http://consul:8500")
    asyncio.run(scenario())
    assert state["queries"] == [("/v1/health/service/cart-service", "passing=true"),
                                ("/v1/kv/config/order-service/data", "raw=true")]


def test_no_instances_and_open_breaker_are_one_warning_each(caplog):
    caplog.set_level(logging.INFO, logger="app")
    state = fresh_state(consul_down=True)
    peers = make_peers(state)

    async def no_instances():
        with pytest.raises(Unavailable):
            await peers.call("cart", "GET", "/cart", CALLER)
    asyncio.run(no_instances())
    assert unavailable_warnings(caplog) == [{"target": "cart", "method": "GET", "reason": "NoInstances"}]

    caplog.clear()
    state = fresh_state(status=500)
    peers = make_peers(state)
    breaker = peers.breakers["inventory"]
    breaker.opened_at = breaker.clock()

    async def open_breaker():
        with pytest.raises(Unavailable):
            await peers.call("inventory", "POST", "/inventory/reservations", CALLER, json={})
    asyncio.run(open_breaker())
    assert not state["inventory"]
    assert unavailable_warnings(caplog) == [{"target": "inventory", "method": "POST", "reason": "CircuitOpen"}]


def test_consul_down_uses_last_known_list_and_breaker_stays_closed(monkeypatch):
    import app.discovery as discovery_module
    state = fresh_state()
    peers = make_peers(state)

    async def scenario():
        assert (await peers.call("inventory", "GET", "/inventory/x", CALLER)).status_code == 200
        state["consul_down"] = True
        monkeypatch.setattr(discovery_module, "CACHE_SECONDS", 0)
        peers.discovery.cache["inventory-service"].expires_at = 0
        for _ in range(12):
            assert (await peers.call("inventory", "GET", "/inventory/x", CALLER)).status_code == 200
    asyncio.run(scenario())
    assert state["consul"] > 1 and len(state["inventory"]) == 13
    assert all(r.url.host == "10.0.0.5" for r in state["inventory"])
    assert list(peers.breakers["inventory"].history).count(False) == 0


def test_consul_down_without_a_list_is_503_and_not_a_breaker_failure():
    state = fresh_state(consul_down=True)
    peers = make_peers(state)

    async def scenario():
        for _ in range(12):
            with pytest.raises(Unavailable):
                await peers.call("inventory", "GET", "/inventory/x", CALLER)
    asyncio.run(scenario())
    assert not state["inventory"] and not peers.breakers["inventory"].history


def test_breaker_opens_after_half_failures_and_4xx_is_not_a_failure():
    state = fresh_state(status=500)
    peers = make_peers(state)

    async def scenario():
        for _ in range(10):
            with pytest.raises(Unavailable):
                await peers.call("inventory", "POST", "/inventory/reservations", CALLER, json={})
        with pytest.raises(Unavailable) as opened:
            await peers.call("inventory", "POST", "/inventory/reservations", CALLER, json={})
        return opened.value.reason
    assert asyncio.run(scenario()) == "CircuitOpen" and len(state["inventory"]) == 10

    state4xx = fresh_state(status=409)
    peers4xx = make_peers(state4xx)

    async def conflicts():
        for _ in range(12):
            assert (await peers4xx.call("inventory", "POST", "/inventory/reservations", CALLER)).status_code == 409
    asyncio.run(conflicts())
    assert len(state4xx["inventory"]) == 12


def test_retries_only_for_get_and_for_connections_never_made():
    state = fresh_state(status=503)
    peers = make_peers(state)

    async def scenario():
        with pytest.raises(Unavailable):
            await peers.call("inventory", "GET", "/inventory/x", CALLER)
        get_calls = len(state["inventory"])
        with pytest.raises(Unavailable):
            await peers.call("inventory", "POST", "/inventory/reservations", CALLER)
        return get_calls, len(state["inventory"]) - get_calls
    assert asyncio.run(scenario()) == (3, 1)

    attempts = []

    async def refused(request):
        attempts.append(request)
        raise httpx.ConnectError("refused", request=request)

    peers.client = httpx.AsyncClient(transport=httpx.MockTransport(refused))
    peers.urls["inventory"] = "http://inventory"

    async def post():
        with pytest.raises(Unavailable):
            await peers.call("inventory", "POST", "/inventory/reservations", CALLER)
    asyncio.run(post())
    assert len(attempts) == 3  # Z22: the service never got the request


def test_breaker_half_open_lets_one_probe():
    now = [0.0]
    breaker = CircuitBreaker(clock=lambda: now[0])

    async def fail():
        raise RuntimeError()

    async def ok():
        return "ok"

    async def scenario():
        for _ in range(10):
            with pytest.raises(RuntimeError):
                await breaker.call(fail)
        with pytest.raises(CircuitOpen):
            await breaker.call(ok)
        now[0] = 31
        assert await breaker.call(ok) == "ok"
        assert await breaker.call(ok) == "ok"
    asyncio.run(scenario())


def test_one_failed_consul_lookup_spares_the_other_services():
    """After Consul failed, other lists are not asked for CACHE_SECONDS (one purchase waits for Consul at most once)."""
    state = fresh_state()
    peers = make_peers(state)

    async def scenario():
        for name in ("cart-service", "product-service"):
            await peers.discovery.resolve(name)
        state["consul_down"] = True
        for entry in peers.discovery.cache.values():
            entry.expires_at = 0
        asked = state["consul"]
        assert await peers.discovery.resolve("cart-service") == "http://10.0.0.5:8084"
        assert await peers.discovery.resolve("product-service") == "http://10.0.0.5:8084"
        return state["consul"] - asked
    assert asyncio.run(scenario()) == 1


OLD = ("order-service-old", "10.0.0.2", 8086)  # entry of a killed process at this address and port


def registration_consul(requests: list, health=(), own_entry=True, errors=None):
    """Consul for run_registration (own ID order-service-x at 10.0.0.2:8086).

    health: (ID, Address, Port) entries listed by GET /v1/health/service/order-service; errors: {(method, path):
    httpx.Response or an httpx exception class}. Requests are recorded as (method, path, query).
    """
    async def consul(request):
        key = (request.method, request.url.path)
        requests.append((*key, request.url.query.decode()))
        error = (errors or {}).get(key)
        if isinstance(error, type):
            raise error("mock", request=request)
        if error is not None:
            return error
        if key == ("GET", "/v1/agent/service/order-service-x"):
            return httpx.Response(200, json={"Address": "10.0.0.2", "Port": 8086}) if own_entry else httpx.Response(404)
        if key == ("GET", "/v1/health/service/order-service"):
            return httpx.Response(200, json=[{"Node": {"Address": "10.0.0.9"}, "Service": {
                "ID": service_id, "Service": "order-service", "Address": address, "Port": port}}
                for service_id, address, port in health])
        return httpx.Response(200)
    return consul


def run_registration(consul, seconds=0.05, **kwargs):
    client = httpx.AsyncClient(transport=httpx.MockTransport(consul))
    discovery = Discovery(client, "http://consul:8500", "order-service", "order-service-x", "10.0.0.2", 8086,
                          **{"check_interval": 60, **kwargs})

    async def scenario():
        task = asyncio.create_task(discovery.run_registration())
        await asyncio.sleep(seconds)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    asyncio.run(scenario())


def deregistered(requests) -> list[str]:
    return [path.rsplit("/", 1)[1] for method, path, _ in requests if "/deregister/" in path]


def test_first_registration_replaces_a_leftover_entry():
    """Z5: a killed process leaves its entry (check critical); the new process deregisters it, registers passing."""
    requests = []
    run_registration(registration_consul(requests, health=[("order-service-x", "10.0.0.2", 8086)]))
    assert [r[:2] for r in requests[:4]] == [("GET", "/v1/health/service/order-service"),
                                             ("GET", "/v1/agent/service/order-service-x"),
                                             ("PUT", "/v1/agent/service/deregister/order-service-x"),
                                             ("PUT", "/v1/agent/service/register")]
    assert requests[-1][:2] == ("PUT", "/v1/agent/service/deregister/order-service-x")  # on shutdown


def test_first_registration_removes_orphans_at_the_same_address_and_port(caplog):
    """Z7: compose recreated the container (new hostname = new ID) with the same IP; the old entry stays passing."""
    caplog.set_level(logging.INFO, logger="app")
    requests = []
    run_registration(registration_consul(requests, own_entry=False, health=[
        OLD, ("order-service-other-ip", "10.0.0.3", 8086), ("order-service-other-port", "10.0.0.2", 9086),
        ("order-service-old-2", "10.0.0.2", 8086)]))
    # No query string: consul-guard allows only none, "passing" and "passing=true" there.
    assert ("GET", "/v1/health/service/order-service", "") in requests
    assert deregistered(requests) == ["order-service-old", "order-service-old-2", "order-service-x"]  # last: shutdown
    assert requests.index(("PUT", "/v1/agent/service/register", "")) > requests.index(
        ("PUT", "/v1/agent/service/deregister/order-service-old-2", ""))
    assert [r.fields for r in caplog.records if r.getMessage().startswith("Removed an orphaned entry")] == [
        {"removedId": "order-service-old"}, {"removedId": "order-service-old-2"}]


@pytest.mark.parametrize("key,error", [
    (("GET", "/v1/health/service/order-service"), httpx.Response(500)),
    (("GET", "/v1/health/service/order-service"), httpx.Response(200, text="not json")),
    (("GET", "/v1/health/service/order-service"), httpx.Response(200, json={"unexpected": "shape"})),
    (("PUT", "/v1/agent/service/deregister/order-service-old"), httpx.Response(403)),  # e.g. consul-guard refuses
])
def test_cleanup_error_does_not_block_the_registration(caplog, key, error):
    caplog.set_level(logging.INFO, logger="app")
    requests = []
    run_registration(registration_consul(requests, own_entry=False, health=[OLD], errors={key: error}))
    assert ("PUT", "/v1/agent/service/register", "") in requests
    assert [m for level, m in discovery_messages(caplog) if level == "WARNING"] == [
        "Could not remove orphaned entries from Consul, registering anyway"]


def test_cleanup_only_at_the_first_registration():
    requests = []
    run_registration(registration_consul(requests, own_entry=False, health=[OLD]), seconds=0.2, check_interval=0.01)
    assert sum(path == "/v1/health/service/order-service" for _, path, _ in requests) == 1
    assert sum(path == "/v1/agent/service/order-service-x" for _, path, _ in requests) > 3  # periodic checks went on
    assert deregistered(requests) == ["order-service-old", "order-service-x"]  # last: shutdown


@pytest.mark.parametrize("error", [httpx.ConnectError, httpx.ReadTimeout])
def test_cleanup_waits_for_the_first_successful_contact(caplog, error):
    """No connection to Consul ends the attempt like the registration: no cleanup warning per retry, the cleanup
    and the registration run at the first successful contact."""
    caplog.set_level(logging.INFO, logger="app")
    requests, down = [], [3]
    reachable = registration_consul(requests, own_entry=False, health=[OLD])

    async def consul(request):
        if down[0]:
            down[0] -= 1
            requests.append(("down", request.url.path, ""))
            raise error("consul down", request=request)
        return await reachable(request)
    run_registration(consul, seconds=0.3, retry_initial=0.01, retry_max=0.02)
    assert [r[:2] for r in requests[:6]] == [("down", "/v1/health/service/order-service")] * 3 + [
        ("GET", "/v1/health/service/order-service"), ("PUT", "/v1/agent/service/deregister/order-service-old"),
        ("GET", "/v1/agent/service/order-service-x")]
    assert ("PUT", "/v1/agent/service/register", "") in requests
    assert [m for level, m in discovery_messages(caplog) if level == "WARNING"] == [
        "Consul unavailable, will register again"]


def discovery_messages(caplog):
    return [(r.levelname, r.getMessage()) for r in caplog.records if r.name == "app.discovery"]


@pytest.fixture
def clock(monkeypatch):
    import app.discovery as discovery_module
    now = [1000.0]
    monkeypatch.setattr(discovery_module, "monotonic", lambda: now[0])
    return now


def test_empty_answer_after_a_list_keeps_the_last_known_list(clock, caplog):
    """Consul restart: registrations restored, checks not passed yet -> empty "passing" list for a moment."""
    caplog.set_level(logging.INFO, logger="app")
    state = fresh_state()
    discovery = make_peers(state).discovery

    async def scenario():
        assert await discovery.resolve("shipping-service") == "http://10.0.0.5:8084"
        state["consul_empty"] = True
        for step in (11, 11, 11):  # list expired each time: Consul asked again, still empty (22 s since the first)
            clock[0] += step
            assert await discovery.resolve("shipping-service") == "http://10.0.0.5:8084"
        state["consul_empty"] = False
        clock[0] += 9  # the kept list expires at the end of the grace time (30 s after the first empty answer)
        assert await discovery.resolve("shipping-service") == "http://10.0.0.5:8084"
    asyncio.run(scenario())
    assert state["consul"] == 5
    assert discovery_messages(caplog) == [
        ("WARNING", "Consul lists no healthy instance, using the last known list"),  # one line per change
        ("INFO", "Consul lists healthy instances again")]


def test_empty_answer_for_30_s_drops_the_list(clock, caplog):
    caplog.set_level(logging.INFO, logger="app")
    state = fresh_state()
    discovery = make_peers(state).discovery

    async def scenario():
        await discovery.resolve("shipping-service")
        state["consul_empty"] = True
        clock[0] += 11
        await discovery.resolve("shipping-service")  # first empty answer: grace starts
        clock[0] += 30
        with pytest.raises(NoInstances):
            await discovery.resolve("shipping-service")
        with pytest.raises(NoInstances):  # no list any more: every lookup asks Consul
            await discovery.resolve("shipping-service")
    asyncio.run(scenario())
    assert "shipping-service" not in discovery.cache
    assert discovery_messages(caplog)[-1] == (
        "WARNING", "Consul still lists no healthy instance, last known list dropped")


def test_empty_answer_without_a_list_is_no_instances(clock):
    state = fresh_state(consul_empty=True)
    discovery = make_peers(state).discovery

    async def scenario():
        with pytest.raises(NoInstances):
            await discovery.resolve("shipping-service")
    asyncio.run(scenario())


def test_grace_counts_from_the_first_empty_answer_not_from_the_last_refresh(clock):
    """A quiet shop refreshes a list only on demand: an old list still bridges the moment after a Consul restart."""
    state = fresh_state()
    discovery = make_peers(state).discovery

    async def scenario():
        await discovery.resolve("cart-service")
        clock[0] += 300  # no purchase for 5 minutes, then Consul restarts and answers "empty"
        state["consul_empty"] = True
        return await discovery.resolve("cart-service")
    assert asyncio.run(scenario()) == "http://10.0.0.5:8084"


def test_empty_answer_after_a_long_consul_outage_keeps_the_last_known_list(clock):
    """Consul stopped, then the leader election: the last non-empty answer is far older than 30 s (variant B)."""
    state = fresh_state()
    discovery = make_peers(state).discovery

    async def scenario():
        await discovery.resolve("shipping-service")
        state["consul_empty"] = True
        clock[0] += 11
        await discovery.resolve("shipping-service")  # an empty series starts...
        state["consul_down"] = True
        for _ in range(6):  # ...and Consul stops: 66 s of errors, the last known list is used
            clock[0] += 11
            assert await discovery.resolve("shipping-service") == "http://10.0.0.5:8084"
        state["consul_down"] = False  # back, checks not passed yet: a new series of empty answers
        clock[0] += 11
        first = await discovery.resolve("shipping-service")
        clock[0] += 29
        return first, await discovery.resolve("shipping-service")
    assert asyncio.run(scenario()) == ("http://10.0.0.5:8084", "http://10.0.0.5:8084")


def test_call_with_too_little_time_left_is_not_made_and_not_counted():
    """CR-4: less than MIN_CALL_SECONDS before the purchase deadline → Unavailable "deadline" without a request;
    a timeout cut short by the deadline would count as a failure of Inventory in its breaker."""
    state = fresh_state()
    peers = make_peers(state)

    async def scenario():
        with pytest.raises(Unavailable) as error:
            await peers.call("inventory", "POST", "/inventory/reservations", CALLER,
                             asyncio.get_running_loop().time() + 0.3, json={})
        return error.value.reason
    assert asyncio.run(scenario()) == "deadline"
    assert state["inventory"] == [] and state["consul"] == 0
    assert not peers.breakers["inventory"].history


@pytest.mark.parametrize("left,connect,limit", [(None, 1.0, 2.0), (1.2, 0.6, 1.2)])
def test_connect_phase_is_shorter_than_the_call_limit(left, connect, limit):
    """CR-1 round 2: each request gets the call limit and at most 1 s (half of a shorter limit) for the connection,
    so an address that does not answer ends as ConnectTimeout (never sent) before the limit, not as TimeoutError."""
    timeouts = []

    async def answer(request):
        timeouts.append(request.extensions["timeout"])
        return httpx.Response(201, json={})

    peers = make_peers(fresh_state())
    peers.client = httpx.AsyncClient(timeout=2, transport=httpx.MockTransport(answer))  # as in main.py
    peers.urls["inventory"] = "http://inventory"

    async def scenario():
        deadline = None if left is None else asyncio.get_running_loop().time() + left
        await peers.call("inventory", "POST", "/inventory/reservations", CALLER, deadline, json={})
    asyncio.run(scenario())
    assert timeouts[0]["connect"] == pytest.approx(connect, abs=0.05)
    assert timeouts[0]["read"] == timeouts[0]["write"] == timeouts[0]["pool"] == pytest.approx(limit, abs=0.05)


def test_refused_orphan_does_not_stop_the_cleanup(caplog):
    """CR-34: 2 orphans, the first deregistration refused (403: Consul's reaper removed the entry between the list and
    the PUT) → the second one is still removed, one warning after the loop, the registration goes on."""
    caplog.set_level(logging.INFO, logger="app")
    requests = []
    run_registration(registration_consul(
        requests, own_entry=False, health=[OLD, ("order-service-old-2", "10.0.0.2", 8086)],
        errors={("PUT", "/v1/agent/service/deregister/order-service-old"): httpx.Response(403)}))
    assert deregistered(requests) == ["order-service-old", "order-service-old-2", "order-service-x"]  # last: shutdown
    assert ("PUT", "/v1/agent/service/register", "") in requests
    assert [r.fields["removedId"] for r in caplog.records if r.getMessage().startswith("Removed an orphaned")] == [
        "order-service-old-2"]
    assert [r.fields for r in caplog.records if r.name == "app.discovery" and r.levelno == logging.WARNING] == [
        {"reason": "HTTP 403", "failed": 1}]


def registration_statuses(ready_answers: list[bool], seconds: float, **kwargs) -> list[str]:
    """Check.Status of every registration while ready() answers from the list (the last answer repeats)."""
    statuses = []

    async def consul(request):
        if request.url.path == "/v1/agent/service/register":
            statuses.append(json.loads(request.content)["Check"]["Status"])
        if request.method == "GET":
            return httpx.Response(404) if "/agent/" in request.url.path else httpx.Response(200, json=[])
        return httpx.Response(200)

    async def ready():
        return ready_answers.pop(0) if len(ready_answers) > 1 else ready_answers[0]
    run_registration(consul, seconds, ready=ready, **kwargs)
    return statuses


@pytest.mark.parametrize("ready,status", [(True, "passing"), (False, "critical")])
def test_registration_status_is_the_current_readiness(ready, status):
    """CR-35: Check.Status from the database check of /health/ready."""
    assert registration_statuses([ready], 0.05) == [status]


def test_registration_again_during_a_database_outage_is_critical():
    """CR-35: Consul removed the entry during a database outage (DeregisterCriticalServiceAfter); registering again as
    passing would send traffic here until the next check."""
    statuses = registration_statuses([True, False], 0.2, check_interval=0.03)
    assert statuses[0] == "passing" and len(statuses) > 2 and set(statuses[1:]) == {"critical"}


def test_info_after_the_last_known_list_was_dropped(clock, caplog):
    """CR-37: the mode ends with the first non-empty answer, also after the list was dropped (30 s of empty answers)."""
    caplog.set_level(logging.INFO, logger="app")
    state = fresh_state()
    discovery = make_peers(state).discovery

    async def scenario():
        await discovery.resolve("shipping-service")
        state["consul_empty"] = True
        clock[0] += 11
        await discovery.resolve("shipping-service")
        clock[0] += 30
        with pytest.raises(NoInstances):
            await discovery.resolve("shipping-service")
        state["consul_empty"] = False
        return await discovery.resolve("shipping-service")
    assert asyncio.run(scenario()) == "http://10.0.0.5:8084"
    assert discovery_messages(caplog) == [
        ("WARNING", "Consul lists no healthy instance, using the last known list"),
        ("WARNING", "Consul still lists no healthy instance, last known list dropped"),
        ("INFO", "Consul lists healthy instances again")]


def test_one_warning_and_one_info_when_a_consul_error_splits_the_empty_answers(clock, caplog):
    """CR-37: a Consul error ends the series of empty answers (variant B), not the mode: no second warning on the next
    empty answer, and the info still comes at the first non-empty one."""
    caplog.set_level(logging.INFO, logger="app")
    state = fresh_state()
    discovery = make_peers(state).discovery

    async def scenario():
        await discovery.resolve("shipping-service")
        for change in ({"consul_empty": True}, {"consul_down": True}, {"consul_down": False}, {"consul_empty": False}):
            state.update(change)
            clock[0] += 11
            await discovery.resolve("shipping-service")
    asyncio.run(scenario())
    assert [m for m in discovery_messages(caplog) if "lists" in m[1]] == [
        ("WARNING", "Consul lists no healthy instance, using the last known list"),
        ("INFO", "Consul lists healthy instances again")]
