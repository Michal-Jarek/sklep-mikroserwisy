import uuid

from pymongo.errors import AutoReconnect, ServerSelectionTimeoutError

from app import db
from app.db import get_reviews
from app.main import app
from tests.conftest import ADMIN, CUSTOMER, OTHER, P1, P2, P_NOT_BOUGHT, P_ORDER_DOWN, U1, add_review


def test_create_review(client, orders, reviews):
    resp = add_review(client, P1, 4, "  Dobry produkt  ", headers={**CUSTOMER, "X-Request-Id": "r-1"})
    assert resp.status_code == 201
    body = resp.json()
    assert body["productId"] == P1 and body["userId"] == U1 and body["rating"] == 4
    assert body["comment"] == "Dobry produkt"
    assert str(uuid.UUID(body["id"])) == body["id"] and body["createdAt"]
    stored = reviews.find_one({"_id": body["id"]})
    assert stored["productId"] == P1 and isinstance(stored["_id"], str)


def test_order_is_called_on_behalf_of_the_customer_with_service_role(client, orders):
    add_review(client, P1, headers={**CUSTOMER, "X-Request-Id": "r-1", "Authorization": "Bearer x"})
    user_id, product_id, headers = orders.calls[0]
    assert (user_id, product_id) == (U1, P1)
    assert headers == {"X-Request-Id": "r-1", "X-User-Id": U1, "X-User-Roles": "CUSTOMER,SERVICE"}


def test_admin_roles_are_forwarded_too(client, orders):
    add_review(client, P1, headers=ADMIN)
    assert orders.calls[0][2]["X-User-Roles"] == "ADMIN,SERVICE"


def test_product_id_is_stored_in_lower_case(client, reviews):
    resp = add_review(client, P1.upper())
    assert resp.status_code == 201 and resp.json()["productId"] == P1
    assert add_review(client, P1).status_code == 409  # ten sam produkt zapisany wielkimi literami


def test_create_requires_authentication(client):
    resp = client.post("/reviews", json={"productId": P1, "rating": 5})
    assert resp.status_code == 401
    assert resp.json()["error"] == "UNAUTHORIZED"


def test_service_role_without_user_id_cannot_create(client):
    assert add_review(client, headers={"X-User-Roles": "SERVICE"}).status_code == 401


def test_user_id_must_be_a_uuid(client):
    resp = add_review(client, headers={"X-User-Id": "u1", "X-User-Roles": "CUSTOMER"})
    assert resp.status_code == 400 and resp.json()["error"] == "VALIDATION_ERROR"


def test_only_buyers_can_review(client):
    resp = add_review(client, product_id=P_NOT_BOUGHT)
    assert resp.status_code == 403
    assert resp.json()["error"] == "FORBIDDEN"


def test_order_service_down_returns_503(client):
    resp = add_review(client, product_id=P_ORDER_DOWN)
    assert resp.status_code == 503
    assert resp.json()["error"] == "SERVICE_UNAVAILABLE"
    assert client.get(f"/reviews/summary/{P_ORDER_DOWN}").json()["reviewCount"] == 0  # nic nie zapisano


def test_second_review_of_same_product_is_conflict(client):
    assert add_review(client, P1).status_code == 201
    resp = add_review(client, P1, rating=1)
    assert resp.status_code == 409
    assert add_review(client, P1, headers=OTHER).status_code == 201


def test_invalid_payload_is_rejected(client):
    for payload in (
        {"productId": P1, "rating": 0},
        {"productId": P1, "rating": 6},
        {"productId": P1, "rating": "4"},
        {"productId": P1, "rating": 4.5},
        {"productId": P1, "rating": True},
        {"productId": 1, "rating": 3},
        {"productId": "not-a-uuid", "rating": 3},
        {"productId": P1.replace("-", ""), "rating": 3},
        {"rating": 3},
        {"productId": P1, "rating": 3, "comment": "x" * 2001},
        {"productId": P1, "rating": 3, "userId": U1},  # nieznane pole
    ):
        resp = client.post("/reviews", json=payload, headers=CUSTOMER)
        assert resp.status_code == 400, payload
        assert resp.json()["error"] == "VALIDATION_ERROR"


def test_blank_comment_is_stored_as_null(client):
    assert add_review(client, P1, comment="   ").json()["comment"] is None


def test_list_requires_product_id(client):
    assert client.get("/reviews").status_code == 400


def test_list_and_summary_reject_malformed_product_id(client):
    for url in ("/reviews?productId=1", "/reviews?productId=not-a-uuid", "/reviews/summary/1", "/reviews/summary/abc"):
        resp = client.get(url)
        assert resp.status_code == 400, url
        assert resp.json()["error"] == "VALIDATION_ERROR"


def test_list_returns_newest_first_with_paging(client):
    for i, headers in enumerate([CUSTOMER, OTHER, ADMIN], start=1):
        add_review(client, P1, rating=i, comment=f"opinia {i}", headers=headers)
    add_review(client, P2, rating=5)  # inny produkt

    body = client.get("/reviews", params={"productId": P1, "size": 2}).json()
    assert body["total"] == 3 and body["page"] == 1 and body["size"] == 2
    assert [r["comment"] for r in body["items"]] == ["opinia 3", "opinia 2"]

    page2 = client.get("/reviews", params={"productId": P1.upper(), "size": 2, "page": 2}).json()
    assert [r["comment"] for r in page2["items"]] == ["opinia 1"]


def test_list_page_out_of_range_is_400_not_500(client):
    # CR-15: page rzędu 10^19 dawało OverflowError w pymongo (skip poza liczbą BSON) → 500
    for page in ("0", "1000001", "99999999999999999999"):
        resp = client.get("/reviews", params={"productId": P1, "page": page})
        assert resp.status_code == 400, page
        assert resp.json()["error"] == "VALIDATION_ERROR"
    last = client.get("/reviews", params={"productId": P1, "page": 1_000_000, "size": 100})
    assert last.status_code == 200 and last.json()["items"] == []


def test_summary_without_reviews(client):
    assert client.get(f"/reviews/summary/{P2}").json() == {"productId": P2, "averageRating": None, "reviewCount": 0}


def test_summary_average_and_count(client):
    add_review(client, P1, rating=5, headers=CUSTOMER)
    add_review(client, P1, rating=4, headers=OTHER)
    add_review(client, P1, rating=4, headers=ADMIN)
    add_review(client, P2, rating=1)
    assert client.get(f"/reviews/summary/{P1}").json() == {"productId": P1, "averageRating": 4.33, "reviewCount": 3}


def test_author_can_delete_own_review(client):
    rid = add_review(client, P1).json()["id"]
    assert client.delete(f"/reviews/{rid}", headers=CUSTOMER).status_code == 204
    assert client.get(f"/reviews/summary/{P1}").json()["reviewCount"] == 0


def test_delete_accepts_upper_case_id(client):
    rid = add_review(client, P1).json()["id"]
    assert client.delete(f"/reviews/{rid.upper()}", headers=CUSTOMER).status_code == 204


def test_other_user_cannot_delete(client):
    rid = add_review(client, P1).json()["id"]
    assert client.delete(f"/reviews/{rid}", headers=OTHER).status_code == 403
    assert client.get(f"/reviews/summary/{P1}").json()["reviewCount"] == 1


def test_admin_can_delete_any_review(client):
    rid = add_review(client, P1).json()["id"]
    assert client.delete(f"/reviews/{rid}", headers=ADMIN).status_code == 204


def test_delete_requires_authentication(client):
    rid = add_review(client, P1).json()["id"]
    assert client.delete(f"/reviews/{rid}").status_code == 401


def test_delete_unknown_id_is_404_and_malformed_id_is_400(client):
    assert client.delete(f"/reviews/{uuid.uuid4()}", headers=ADMIN).status_code == 404
    for bad in ("not-an-id", "64b7f0f0f0f0f0f0f0f0f0f0"):  # także dawny ObjectId
        resp = client.delete(f"/reviews/{bad}", headers=ADMIN)
        assert resp.status_code == 400 and resp.json()["error"] == "VALIDATION_ERROR"


def test_error_format_and_headers(client):
    resp = client.get("/reviews", headers={"X-Request-Id": "abc"})
    body = resp.json()
    assert set(body) == {"status", "error", "message", "requestId"}
    assert body["requestId"] == "abc" and resp.headers["X-Request-Id"] == "abc"
    assert "X-Instance-Id" in resp.headers


def test_request_id_outside_the_pattern_is_replaced(client):
    resp = client.get("/reviews", headers={"X-Request-Id": "bad id with space"})
    assert str(uuid.UUID(resp.json()["requestId"])) == resp.headers["X-Request-Id"]


class BrokenCollection:
    """Kolekcja, której każda operacja kończy się błędem połączenia z MongoDB."""

    def __init__(self, exc):
        self.exc = exc

    def __getattr__(self, name):
        def fail(*args, **kwargs):
            raise self.exc

        return fail


def test_database_unavailable_is_503_with_request_id(client):
    for exc in (ServerSelectionTimeoutError("no servers"), AutoReconnect("connection reset")):
        app.dependency_overrides[get_reviews] = lambda exc=exc: BrokenCollection(exc)
        for method, url in (("GET", f"/reviews?productId={P1}"), ("GET", f"/reviews/summary/{P1}")):
            resp = client.request(method, url, headers={"X-Request-Id": "req-db"})
            assert resp.status_code == 503, (exc, url)
            assert resp.json() == {
                "status": 503, "error": "SERVICE_UNAVAILABLE", "message": "Baza danych niedostępna", "requestId": "req-db",
            }
            assert resp.headers["X-Request-Id"] == "req-db"
        assert add_review(client, P1).status_code == 503


def test_health(client, monkeypatch):
    assert client.get("/health/live").json() == {"status": "UP"}
    monkeypatch.setattr(db, "ping", lambda: None)
    assert client.get("/health/ready").status_code == 200

    def broken():
        raise ServerSelectionTimeoutError("mongo down")

    monkeypatch.setattr(db, "ping", broken)
    resp = client.get("/health/ready")
    assert resp.status_code == 503 and resp.json()["error"] == "SERVICE_UNAVAILABLE"
