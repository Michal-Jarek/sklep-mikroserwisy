"""Contract of Product (docs/frontend-api.md) and the team rules D1-D20 that apply to it."""

import uuid

import httpx

from .conftest import ADMIN, BOOKS, CUSTOMER, KITCHEN, KUBEK

# ----- health, headers, errors -----

def test_health(client):
    assert client.get("/health/live").json() == {"status": "UP"}
    assert client.get("/health/ready").json() == {"status": "UP"}


def test_request_and_instance_id_headers(client):
    response = client.get("/categories", headers={"X-Request-Id": "test-1"})
    assert response.headers["X-Request-Id"] == "test-1"
    assert response.headers["X-Instance-Id"] == "product-service-test"


def test_error_format_unknown_path_and_trailing_slash(client):
    response = client.get("/nope", headers={"X-Request-Id": "abc"})
    assert response.status_code == 404
    assert response.json() == {"status": 404, "error": "NOT_FOUND", "message": "Not Found", "requestId": "abc"}
    # D12: no redirect for a trailing slash.
    assert client.get("/products/", follow_redirects=False).status_code == 404


def test_method_not_allowed(client):
    response = client.patch(f"/products/{KUBEK}")
    assert response.status_code == 405
    assert response.json()["error"] == "METHOD_NOT_ALLOWED"


def test_head_works_like_get(client):
    assert client.head("/products").status_code == 200
    assert client.head(f"/products/{KUBEK}").status_code == 200
    assert client.head("/categories").status_code == 200


# ----- GET /categories -----

def test_categories_alphabetical(client):
    names = [c["name"] for c in client.get("/categories").json()]
    assert names == ["Elektronika", "Książki", "Kuchnia", "Ogród"]


# ----- GET /products -----

def test_list_default_page(client):
    body = client.get("/products").json()
    assert body["page"] == 1 and body["size"] == 20 and body["total"] == 24
    assert len(body["items"]) == 20
    first = body["items"][0]
    assert set(first) == {"id", "name", "price", "currency", "categoryId", "imageUrl"}
    # D3: amount as text with two decimals, with currency.
    assert isinstance(first["price"], str) and first["currency"] == "PLN"
    # sort=NAME by default (exact order of Polish letters depends on the database collation)
    assert body["items"][0]["name"] == "Algorytmy"


def test_list_second_page_and_out_of_range(client):
    assert len(client.get("/products", params={"page": 2}).json()["items"]) == 4
    body = client.get("/products", params={"page": 9}).json()
    assert body["items"] == [] and body["total"] == 24


def test_list_search_category_and_price(client):
    found = client.get("/products", params={"q": "  KUBEK "}).json()
    assert [p["id"] for p in found["items"]] == [KUBEK]
    # search also in the description
    assert client.get("/products", params={"q": "zmywarce"}).json()["total"] == 1
    books = client.get("/products", params={"categoryId": BOOKS}).json()
    assert books["total"] == 6 and {p["categoryId"] for p in books["items"]} == {BOOKS}
    cheap = client.get("/products", params={"maxPrice": "20", "sort": "PRICE_ASC"}).json()
    prices = [p["price"] for p in cheap["items"]]
    assert prices == ["9.99", "19.90", "19.99"]
    window = client.get("/products", params={"minPrice": "19.99", "maxPrice": "19.99"}).json()
    assert [p["id"] for p in window["items"]] == [KUBEK]


def test_list_unknown_category_is_empty(client):
    body = client.get("/products", params={"categoryId": str(uuid.uuid4())}).json()
    assert body["items"] == [] and body["total"] == 0


def test_list_sorting(client):
    desc = [p["price"] for p in client.get("/products", params={"sort": "PRICE_DESC", "size": 3}).json()["items"]]
    assert desc == ["299.00", "249.99", "159.00"]
    newest = client.get("/products", params={"sort": "NEWEST", "size": 1}).json()["items"][0]
    assert newest["name"] == "Nasiona ziół"


def test_list_invalid_parameters(client):
    for params in ({"page": 0}, {"size": 101}, {"size": "x"}, {"sort": "PRICE"}, {"minPrice": "abc"},
                   {"minPrice": "10.555"}, {"categoryId": "123"}, {"minPrice": "50", "maxPrice": "10"},
                   {"q": "x" * 201}):
        response = client.get("/products", params=params)
        assert response.status_code == 400, params
        assert response.json()["error"] == "VALIDATION_ERROR"


# ----- GET /products/{id} -----

def test_detail_with_rating_and_availability(client, services):
    body = client.get(f"/products/{KUBEK}", headers={**CUSTOMER, "X-Request-Id": "r-1"}).json()
    assert body["name"] == "Kubek ceramiczny" and body["price"] == "19.99"
    assert body["category"] == {"id": KITCHEN, "name": "Kuchnia"}
    assert body["rating"] == {"average": 4.5, "count": 12}
    assert body["availability"] == {"available": 10, "inStock": True}
    assert body["createdAt"].endswith("Z") and body["updatedAt"].endswith("Z")
    # D11: identity, SERVICE and the request id go to the other services.
    review = next(r for r in services.requests if r.url.host == "review")
    assert review.url.path == f"/reviews/summary/{KUBEK}"
    assert review.headers["X-User-Roles"] == "CUSTOMER,SERVICE"
    assert review.headers["X-User-Id"] == CUSTOMER["X-User-Id"]
    assert review.headers["X-Request-Id"] == "r-1"


def test_detail_anonymous_client_works(client, services):
    response = client.get(f"/products/{KUBEK}")
    assert response.status_code == 200
    assert services.requests[0].headers["X-User-Roles"] == "SERVICE"
    assert "X-User-Id" not in services.requests[0].headers


def test_detail_light_read_for_service(client, services):
    # D4: with SERVICE no calls to Review or Inventory.
    body = client.get(f"/products/{KUBEK}", headers={"X-User-Roles": "SERVICE"}).json()
    assert body["rating"] is None and body["availability"] is None
    assert body["id"] == KUBEK and body["price"] == "19.99" and body["currency"] == "PLN"
    assert services.requests == []


def change_in_database(database_url, **values):
    """A write made by another instance of Product: the cache of this instance is not cleared."""
    import uuid

    from sqlalchemy import create_engine, update
    from sqlalchemy.orm import Session

    from app.models import Product

    engine = create_engine(database_url)
    with Session(engine) as session, session.begin():
        session.execute(update(Product).where(Product.id == uuid.UUID(KUBEK)).values(**values))
    engine.dispose()


def test_light_read_skips_cache(client, database_url):
    # D4, review of PR #11: Cart must get the new price at once, not after the cache TTL.
    from decimal import Decimal

    assert client.get(f"/products/{KUBEK}").json()["price"] == "19.99"  # now in the cache
    change_in_database(database_url, price=Decimal("29.99"))
    assert client.get(f"/products/{KUBEK}").json()["price"] == "19.99"  # catalog: cache, up to 60 s
    service = client.get(f"/products/{KUBEK}", headers={"X-User-Roles": "SERVICE"}).json()
    assert service["price"] == "29.99"


def test_light_read_does_not_see_withdrawn_product(client, database_url):
    from datetime import UTC, datetime

    assert client.get(f"/products/{KUBEK}").status_code == 200  # now in the cache
    change_in_database(database_url, deleted_at=datetime.now(UTC))
    response = client.get(f"/products/{KUBEK}", headers={"X-User-Roles": "SERVICE"})
    assert response.status_code == 404 and response.json()["error"] == "NOT_FOUND"


def test_detail_when_review_and_inventory_are_down(client, services):
    def down(request):
        raise httpx.ConnectError("refused", request=request)

    services.review = down
    services.inventory = lambda request: httpx.Response(404, json={"status": 404, "error": "NOT_FOUND"})
    body = client.get(f"/products/{KUBEK}").json()
    assert body["rating"] is None
    assert body["availability"] is None
    # Connection errors are retried (3 attempts); 404 is an answer, not retried.
    assert sum(r.url.host == "review" for r in services.requests) == 3
    assert sum(r.url.host == "inventory" for r in services.requests) == 1


def test_detail_rating_without_reviews(client, services):
    services.review = lambda request: httpx.Response(200, json={"averageRating": None, "reviewCount": 0})
    assert client.get(f"/products/{KUBEK}").json()["rating"] == {"average": None, "count": 0}


def test_detail_answer_outside_contract_is_no_data(client, services):
    services.inventory = lambda request: httpx.Response(200, json={"available": "ten"})
    assert client.get(f"/products/{KUBEK}").json()["availability"] is None


def test_detail_not_found_and_invalid_id(client):
    response = client.get(f"/products/{uuid.uuid4()}")
    assert response.status_code == 404 and response.json()["error"] == "NOT_FOUND"
    response = client.get("/products/123")
    assert response.status_code == 400 and response.json()["error"] == "VALIDATION_ERROR"


def test_invalid_user_id_header(client):
    response = client.get("/products", headers={"X-User-Id": "not-a-uuid"})
    assert response.status_code == 400


# ----- POST, PUT, DELETE (ADMIN) -----

def test_create_requires_login_and_admin(client, new_product):
    assert client.post("/products", json=new_product).status_code == 401
    response = client.post("/products", json=new_product, headers=CUSTOMER)
    assert response.status_code == 403 and response.json()["error"] == "FORBIDDEN"
    # role as a list element, never a substring (D11)
    assert client.post("/products", json=new_product, headers={**CUSTOMER, "X-User-Roles": "XADMIN"}).status_code == 403


def test_create_product(client, new_product, services):
    response = client.post("/products", json={**new_product, "name": "  Kubek termiczny  "}, headers=ADMIN)
    assert response.status_code == 201
    body = response.json()
    assert uuid.UUID(body["id"]).version == 4
    assert body["name"] == "Kubek termiczny"
    assert body["price"] == "39.99" and body["currency"] == "PLN"
    assert body["category"] == {"id": KITCHEN, "name": "Kuchnia"}
    assert body["rating"] == {"average": None, "count": 0} and body["availability"] is None
    assert services.requests == []
    # visible in the list right away (the cache was cleared)
    assert client.get("/products", params={"q": "termiczny"}).json()["total"] == 1
    assert client.get(f"/products/{body['id']}").status_code == 200


def test_create_validation(client, new_product):
    bad = [
        {"price": 39.99},  # number instead of text (D3)
        {"price": "0.00"},
        {"price": "39.9"},
        {"currency": "EUR"},
        {"name": "   "},
        {"name": "x" * 201},
        {"description": "x" * 5001},
        {"imageUrl": "http://img.example.com/a.jpg"},
        {"categoryId": "123"},
        {"categoryId": str(uuid.uuid4())},  # unknown category
        {"unknownField": 1},
    ]
    for change in bad:
        response = client.post("/products", json={**new_product, **change}, headers=ADMIN)
        assert response.status_code == 400, change
        assert response.json()["error"] == "VALIDATION_ERROR", change


def test_replace_product(client, new_product):
    response = client.get(f"/products/{KUBEK}")  # fills the cache
    assert response.json()["name"] == "Kubek ceramiczny"
    changed = {**new_product, "name": "Kubek XXL", "price": "24.50", "categoryId": BOOKS, "imageUrl": None}
    response = client.put(f"/products/{KUBEK}", json=changed, headers=ADMIN)
    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "Kubek XXL" and body["price"] == "24.50" and body["category"]["name"] == "Książki"
    assert body["imageUrl"] is None
    # the cache does not return the old version
    assert client.get(f"/products/{KUBEK}").json()["name"] == "Kubek XXL"


def test_replace_unknown_product(client, new_product):
    assert client.put(f"/products/{uuid.uuid4()}", json=new_product, headers=ADMIN).status_code == 404
    assert client.put(f"/products/{KUBEK}", json=new_product, headers=CUSTOMER).status_code == 403


def test_delete_product(client):
    assert client.delete(f"/products/{KUBEK}", headers=CUSTOMER).status_code == 403
    assert client.get(f"/products/{KUBEK}").status_code == 200  # fills the cache
    response = client.delete(f"/products/{KUBEK}", headers=ADMIN)
    assert response.status_code == 204 and response.content == b""
    # D4: a withdrawn product is 404, also for the light read
    assert client.get(f"/products/{KUBEK}").status_code == 404
    assert client.get(f"/products/{KUBEK}", headers={"X-User-Roles": "SERVICE"}).status_code == 404
    assert client.get("/products").json()["total"] == 23
    assert client.delete(f"/products/{KUBEK}", headers=ADMIN).status_code == 404


def test_openapi_available(client):
    assert client.get("/openapi.json").status_code == 200


def test_database_down_gives_503():
    # Nothing listens on port 1: no connection to the own database (D7, D15).
    from fastapi.testclient import TestClient

    from app.config import Settings
    from app.main import create_app

    settings = Settings(db_url="postgresql+psycopg://u:p@127.0.0.1:1/product_db", consul_enabled=False)
    with TestClient(create_app(settings)) as down:
        assert down.get("/health/live").status_code == 200
        assert down.get("/health/ready").status_code == 503
        response = down.get("/products")
        assert response.status_code == 503 and response.json()["error"] == "SERVICE_UNAVAILABLE"
