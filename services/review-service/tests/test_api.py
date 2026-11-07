from app import db
from tests.conftest import ADMIN, CUSTOMER, OTHER, add_review


def test_create_review(client, orders):
    resp = add_review(client, 1, 4, "  Dobry produkt  ", headers={**CUSTOMER, "X-Request-Id": "r-1"})
    assert resp.status_code == 201
    body = resp.json()
    assert body["productId"] == 1 and body["userId"] == "u1" and body["rating"] == 4
    assert body["comment"] == "Dobry produkt"
    assert body["id"] and body["createdAt"]
    # do Order Service przekazujemy X-Request-Id
    assert orders.calls[0][2]["X-Request-Id"] == "r-1"


def test_create_requires_authentication(client):
    resp = client.post("/reviews", json={"productId": 1, "rating": 5})
    assert resp.status_code == 401
    assert resp.json()["error"] == "UNAUTHORIZED"


def test_service_role_without_user_id_cannot_create(client):
    resp = add_review(client, headers={"X-User-Roles": "SERVICE"})
    assert resp.status_code == 401


def test_only_buyers_can_review(client):
    resp = add_review(client, product_id=999)
    assert resp.status_code == 403
    assert resp.json()["error"] == "FORBIDDEN"


def test_order_service_down_returns_503(client):
    resp = add_review(client, product_id=888)
    assert resp.status_code == 503
    assert resp.json()["error"] == "SERVICE_UNAVAILABLE"
    assert client.get("/reviews/summary/888").json()["reviewCount"] == 0  # nic nie zapisano


def test_second_review_of_same_product_is_conflict(client):
    assert add_review(client, 1).status_code == 201
    resp = add_review(client, 1, rating=1)
    assert resp.status_code == 409
    assert add_review(client, 1, headers=OTHER).status_code == 201


def test_invalid_payload_is_rejected(client):
    for payload in (
        {"productId": 1, "rating": 0},
        {"productId": 1, "rating": 6},
        {"productId": 0, "rating": 3},
        {"rating": 3},
        {"productId": 1, "rating": 3, "comment": "x" * 2001},
    ):
        resp = client.post("/reviews", json=payload, headers=CUSTOMER)
        assert resp.status_code == 400, payload
        assert resp.json()["error"] == "VALIDATION_ERROR"


def test_blank_comment_is_stored_as_null(client):
    assert add_review(client, 1, comment="   ").json()["comment"] is None


def test_list_requires_product_id(client):
    assert client.get("/reviews").status_code == 400


def test_list_returns_newest_first_with_paging(client):
    for i, headers in enumerate([CUSTOMER, OTHER, ADMIN], start=1):
        add_review(client, 1, rating=i, comment=f"opinia {i}", headers=headers)
    add_review(client, 2, rating=5)  # inny produkt

    body = client.get("/reviews", params={"productId": 1, "size": 2}).json()
    assert body["total"] == 3 and body["page"] == 1 and body["size"] == 2
    assert [r["comment"] for r in body["items"]] == ["opinia 3", "opinia 2"]

    page2 = client.get("/reviews", params={"productId": 1, "size": 2, "page": 2}).json()
    assert [r["comment"] for r in page2["items"]] == ["opinia 1"]


def test_summary_without_reviews(client):
    assert client.get("/reviews/summary/5").json() == {"productId": 5, "averageRating": None, "reviewCount": 0}


def test_summary_average_and_count(client):
    add_review(client, 1, rating=5, headers=CUSTOMER)
    add_review(client, 1, rating=4, headers=OTHER)
    add_review(client, 1, rating=4, headers=ADMIN)
    add_review(client, 2, rating=1)
    assert client.get("/reviews/summary/1").json() == {"productId": 1, "averageRating": 4.33, "reviewCount": 3}


def test_author_can_delete_own_review(client):
    rid = add_review(client, 1).json()["id"]
    assert client.delete(f"/reviews/{rid}", headers=CUSTOMER).status_code == 204
    assert client.get("/reviews/summary/1").json()["reviewCount"] == 0


def test_other_user_cannot_delete(client):
    rid = add_review(client, 1).json()["id"]
    assert client.delete(f"/reviews/{rid}", headers=OTHER).status_code == 403
    assert client.get("/reviews/summary/1").json()["reviewCount"] == 1


def test_admin_can_delete_any_review(client):
    rid = add_review(client, 1).json()["id"]
    assert client.delete(f"/reviews/{rid}", headers=ADMIN).status_code == 204


def test_delete_requires_authentication(client):
    rid = add_review(client, 1).json()["id"]
    assert client.delete(f"/reviews/{rid}").status_code == 401


def test_delete_unknown_or_malformed_id_returns_404(client):
    assert client.delete("/reviews/64b7f0f0f0f0f0f0f0f0f0f0", headers=ADMIN).status_code == 404
    assert client.delete("/reviews/not-an-id", headers=ADMIN).status_code == 404


def test_error_format_and_headers(client):
    resp = client.get("/reviews", headers={"X-Request-Id": "abc"})
    body = resp.json()
    assert set(body) == {"status", "error", "message", "requestId"}
    assert body["requestId"] == "abc"
    assert "X-Instance-Id" in resp.headers


def test_health(client, monkeypatch):
    assert client.get("/health/live").json() == {"status": "UP"}
    monkeypatch.setattr(db, "ping", lambda: None)
    assert client.get("/health/ready").status_code == 200

    def broken():
        raise RuntimeError("mongo down")

    monkeypatch.setattr(db, "ping", broken)
    assert client.get("/health/ready").status_code == 503

