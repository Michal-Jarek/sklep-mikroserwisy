"""HTTP helper of run.sh (K14). Runs in python:3.12-slim on the network sklep_backend and calls the services directly
with the headers the API Gateway would set (X-User-Id, X-User-Roles, X-Request-Id): no JWT and no login limit.
Standard library only. One JSON line per result on stdout.

  stock <product>                         -> {"code", "quantity", "reserved"}
  set-stock <product> <quantity>          -> {"code", "quantity", "reserved"}  (ADMIN)
  parallel <n> <product>                  -> n new customers: cart + POST /orders at once
                                             {"codes": {...}, "statuses": {...}, "maxS", "times": [...], "orders": [[user, id], ...]}
  buy <n> <product>                       -> like parallel, one after another
  buy-as <user> <product>                 -> one purchase of an existing customer (the e-mail goes to its address)
  cancel <user>:<order> ...               -> {"codes": {...}}
"""

import json
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid

ORDER = "http://order-service:8086"
CART = "http://cart-service:8085"
INVENTORY = "http://inventory-service:8084"
ADMIN = "e8700000-0000-4000-8000-000000000001"
ORDER_BODY = {
    "shippingMethod": "COURIER",
    "shippingAddress": {"firstName": "K14", "lastName": "Test", "street": "ul. Testowa 1", "postalCode": "00-001",
                        "city": "Warszawa", "countryCode": "PL"},
    "payment": {"cardNumber": "4111111111111111"},
}


def call(method, url, user, roles="CUSTOMER", body=None, headers=None, timeout=15):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method=method, headers={
        "X-User-Id": user, "X-User-Roles": roles, "X-Request-Id": f"e8t7-k14-{uuid.uuid4().hex[:12]}",
        "Content-Type": "application/json", **(headers or {})})
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            code, text = response.status, response.read().decode()
    except urllib.error.HTTPError as error:
        code, text = error.code, error.read().decode()
    except (urllib.error.URLError, TimeoutError) as error:
        code, text = 0, json.dumps({"error": type(error).__name__})
    try:
        payload = json.loads(text) if text else {}
    except ValueError:
        payload = {}
    return code, payload, time.monotonic() - started


def stock(product):
    code, body, _ = call("GET", f"{INVENTORY}/inventory/{product}", ADMIN, "ADMIN")
    return {"code": code, "quantity": body.get("quantity"), "reserved": body.get("reserved")}


def set_stock(product, quantity):
    code, body, _ = call("PUT", f"{INVENTORY}/inventory/{product}", ADMIN, "ADMIN", {"quantity": int(quantity)})
    return {"code": code, "quantity": body.get("quantity"), "reserved": body.get("reserved")}


def purchases(users, product, at_once):
    cart_codes = {}
    for user in users:
        code, _, _ = call("POST", f"{CART}/cart/items", user, body={"productId": product, "quantity": 1})
        cart_codes[str(code)] = cart_codes.get(str(code), 0) + 1
    results = [None] * len(users)
    barrier = threading.Barrier(len(users)) if at_once else None

    def buy(index):
        if barrier:
            barrier.wait()
        code, body, seconds = call("POST", f"{ORDER}/orders", users[index], body=ORDER_BODY,
                                   headers={"Idempotency-Key": str(uuid.uuid4())})
        results[index] = (code, body.get("status") or body.get("error"), round(seconds, 2), body.get("id"))

    if at_once:
        threads = [threading.Thread(target=buy, args=(i,)) for i in range(len(users))]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
    else:
        for i in range(len(users)):
            buy(i)
    codes, statuses = {}, {}
    for code, status, _, _ in results:
        codes[str(code)] = codes.get(str(code), 0) + 1
        statuses[str(status)] = statuses.get(str(status), 0) + 1
    return {"cart": cart_codes, "codes": codes, "statuses": statuses, "maxS": max(r[2] for r in results),
            "times": [r[2] for r in results],
            "orders": [[user, r[3]] for user, r in zip(users, results) if r[3]]}


def cancel(pairs):
    codes = {}
    for pair in pairs:
        user, order = pair.split(":")
        code, _, _ = call("POST", f"{ORDER}/orders/{order}/cancel", user)
        codes[str(code)] = codes.get(str(code), 0) + 1
    return {"codes": codes}


def main(argv):
    command, args = argv[0], argv[1:]
    if command == "stock":
        result = stock(args[0])
    elif command == "set-stock":
        result = set_stock(args[0], args[1])
    elif command == "parallel":
        result = purchases([str(uuid.uuid4()) for _ in range(int(args[0]))], args[1], at_once=True)
    elif command == "buy":
        result = purchases([str(uuid.uuid4()) for _ in range(int(args[0]))], args[1], at_once=False)
    elif command == "buy-as":
        result = purchases([args[0]], args[1], at_once=False)
    elif command == "cancel":
        result = cancel(args)
    else:
        raise SystemExit(f"unknown command {command}")
    print(json.dumps(result))


if __name__ == "__main__":
    main(sys.argv[1:])
