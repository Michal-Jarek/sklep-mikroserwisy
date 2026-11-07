from tests.conftest import ADMIN, CUSTOMER, SERVICE


def reserve(client, order_id, items, headers=SERVICE):
    return client.post(
        "/inventory/reservations",
        json={"orderId": order_id, "items": [{"productId": p, "quantity": q} for p, q in items]},
        headers=headers,
    )


def stock(client, product_id):
    return client.get(f"/inventory/{product_id}").json()


# --- stany -----------------------------------------------------------------

def test_unknown_product_returns_404_in_team_error_format(client):
    resp = client.get("/inventory/999", headers={"X-Request-Id": "req-1"})
    assert resp.status_code == 404
    body = resp.json()
    assert body["status"] == 404
    assert body["error"] == "NOT_FOUND"
    assert body["requestId"] == "req-1"
    assert resp.headers["X-Request-Id"] == "req-1"
    assert "X-Instance-Id" in resp.headers


def test_put_requires_authentication_and_admin_role(client):
    assert client.put("/inventory/1", json={"quantity": 5}).status_code == 401
    assert client.put("/inventory/1", json={"quantity": 5}, headers=CUSTOMER).status_code == 403
    assert client.put("/inventory/1", json={"quantity": 5}, headers=SERVICE).status_code == 403


def test_admin_sets_and_reads_stock(client):
    resp = client.put("/inventory/1", json={"quantity": 5}, headers=ADMIN)
    assert resp.status_code == 200
    assert resp.json() == {"productId": 1, "quantity": 5, "reserved": 0, "available": 5, "inStock": True}
    assert stock(client, 1)["available"] == 5


def test_zero_quantity_means_out_of_stock(client):
    client.put("/inventory/1", json={"quantity": 0}, headers=ADMIN)
    assert stock(client, 1)["inStock"] is False


def test_negative_quantity_is_rejected(client):
    resp = client.put("/inventory/1", json={"quantity": -1}, headers=ADMIN)
    assert resp.status_code == 400
    assert resp.json()["error"] == "VALIDATION_ERROR"


def test_cannot_lower_stock_below_reserved(client, stocked):
    assert reserve(client, "o1", [(stocked, 6)]).status_code == 201
    resp = client.put(f"/inventory/{stocked}", json={"quantity": 5}, headers=ADMIN)
    assert resp.status_code == 409


# --- rezerwacje ------------------------------------------------------------

def test_reservation_requires_service_role(client, stocked):
    assert reserve(client, "o1", [(stocked, 1)], headers={}).status_code == 401
    assert reserve(client, "o1", [(stocked, 1)], headers=CUSTOMER).status_code == 403
    assert reserve(client, "o1", [(stocked, 1)], headers=ADMIN).status_code == 403


def test_reservation_reduces_available(client, stocked):
    resp = reserve(client, "o1", [(stocked, 3)])
    assert resp.status_code == 201
    assert resp.json() == {"orderId": "o1", "status": "ACTIVE", "items": [{"productId": stocked, "quantity": 3}]}
    s = stock(client, stocked)
    assert (s["reserved"], s["available"]) == (3, 7)


def test_repeated_reservation_for_same_order_is_idempotent(client, stocked):
    assert reserve(client, "o1", [(stocked, 3)]).status_code == 201
    assert reserve(client, "o1", [(stocked, 3)]).status_code == 200
    assert stock(client, stocked)["reserved"] == 3


def test_insufficient_stock_returns_409_and_changes_nothing(client, stocked):
    client.put("/inventory/11", json={"quantity": 1}, headers=ADMIN)
    resp = reserve(client, "o1", [(stocked, 2), (11, 5)])
    assert resp.status_code == 409
    assert resp.json()["error"] == "INSUFFICIENT_STOCK"
    assert "11" in resp.json()["message"]
    assert stock(client, stocked)["reserved"] == 0  # rezerwacja jest atomowa
    assert stock(client, 11)["reserved"] == 0


def test_unknown_product_cannot_be_reserved(client):
    assert reserve(client, "o1", [(404, 1)]).status_code == 409


def test_duplicate_items_in_one_request_are_summed(client, stocked):
    resp = reserve(client, "o1", [(stocked, 2), (stocked, 3)])
    assert resp.status_code == 201
    assert resp.json()["items"] == [{"productId": stocked, "quantity": 5}]


def test_invalid_reservation_body(client):
    for body in (
        {"orderId": "o1", "items": []},
        {"orderId": "", "items": [{"productId": 1, "quantity": 1}]},
        {"orderId": "o1", "items": [{"productId": 1, "quantity": 0}]},
    ):
        resp = client.post("/inventory/reservations", json=body, headers=SERVICE)
        assert resp.status_code == 400, body


def test_release_restores_stock_and_is_idempotent(client, stocked):
    reserve(client, "o1", [(stocked, 4)])
    assert client.delete("/inventory/reservations/o1", headers=SERVICE).status_code == 204
    assert stock(client, stocked)["available"] == 10
    assert client.delete("/inventory/reservations/o1", headers=SERVICE).status_code == 204
    assert stock(client, stocked)["available"] == 10


def test_released_order_cannot_be_reserved_again(client, stocked):
    reserve(client, "o1", [(stocked, 1)])
    client.delete("/inventory/reservations/o1", headers=SERVICE)
    assert reserve(client, "o1", [(stocked, 1)]).status_code == 409


def test_release_requires_service_role(client):
    assert client.delete("/inventory/reservations/o1").status_code == 401
    assert client.delete("/inventory/reservations/o1", headers=CUSTOMER).status_code == 403


# --- health ----------------------------------------------------------------

def test_health_endpoints(client):
    assert client.get("/health/live").json() == {"status": "UP"}
    assert client.get("/health/ready").json() == {"status": "UP"}


def test_ready_returns_503_when_database_is_down(client, monkeypatch):
    from app import db

    def broken():
        raise RuntimeError("db down")

    monkeypatch.setattr(db, "ping", broken)
    resp = client.get("/health/ready")
    assert resp.status_code == 503
    assert resp.json()["error"] == "SERVICE_UNAVAILABLE"
