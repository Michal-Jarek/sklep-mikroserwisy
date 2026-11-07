from uuid import uuid4
import pytest


def headers(user_id=None, roles="CUSTOMER"):
    result = {"X-User-Roles": roles, "X-Request-Id": "user-test"}
    if user_id:
        result["X-User-Id"] = str(user_id)
    return result


def profile(client, **overrides):
    user_id = str(uuid4())
    data = {"id": user_id, "firstName": "Anna", "lastName": "Nowak", "email": f"{user_id}@example.com"}
    data.update(overrides)
    response = client.post("/users", json=data, headers=headers(roles="SERVICE"))
    assert response.status_code == 201, response.text
    return response.json()


def test_create_and_read_own_profile(client):
    user = profile(client)
    response = client.get("/users/me", headers=headers(user["id"]))
    assert response.status_code == 200
    assert response.json() == user
    assert response.headers["x-request-id"] == "user-test"
    assert response.headers["x-instance-id"]
    assert "password" not in response.json()


def test_update_keeps_id_and_email(client):
    user = profile(client)
    response = client.put("/users/me", json={"firstName": " Ewa ", "lastName": "Lis"}, headers=headers(user["id"]))
    assert response.status_code == 200
    assert response.json() == {**user, "firstName": "Ewa", "lastName": "Lis"}
    assert client.get("/users/me", headers=headers(user["id"])).json()["firstName"] == "Ewa"


def test_cannot_change_email_or_roles_through_profile(client):
    user = profile(client)
    for extra in ({"email": "other@example.com"}, {"roles": ["ADMIN"]}, {"id": str(uuid4())}):
        response = client.put("/users/me", headers=headers(user["id"]), json={"firstName": "A", "lastName": "B", **extra})
        assert response.status_code == 400
    assert client.get("/users/me", headers=headers(user["id"])).json() == user


def test_create_requires_service(client):
    response = client.post("/users", headers=headers(uuid4()), json={"id": str(uuid4()), "firstName": "A", "lastName": "B", "email": "a@example.com"})
    assert response.status_code == 403


@pytest.mark.parametrize("role", ["ADMIN", "SERVICE"])
def test_notification_and_admin_can_read_by_id(client, role):
    user = profile(client)
    response = client.get(f"/users/{user['id']}", headers=headers(roles=role))
    assert response.status_code == 200
    assert response.json()["email"] == user["email"]


def test_customer_cannot_read_other_profile(client):
    user = profile(client)
    assert client.get(f"/users/{user['id']}", headers=headers(uuid4())).status_code == 403


def test_no_identity_or_invalid_identity(client):
    assert client.get("/users/me").status_code == 401
    assert client.get("/users/me", headers=headers("not-a-uuid")).status_code == 401
    assert client.get("/users/me", headers=headers(uuid4(), "UNKNOWN")).status_code == 403


def test_duplicates_are_conflicts(client):
    user = profile(client)
    assert client.post("/users", headers=headers(roles="SERVICE"), json=user).status_code == 409
    assert client.post("/users", headers=headers(roles="SERVICE"), json={**user, "id": str(uuid4())}).status_code == 409


def test_address_ownership_and_delete(client):
    owner, other = profile(client), profile(client)
    body = {"street": "Lipowa 1", "city": "Warszawa", "postalCode": "00-001", "countryCode": "PL"}
    response = client.post("/users/me/addresses", headers=headers(owner["id"]), json=body)
    assert response.status_code == 201
    address_id = response.json()["id"]
    assert len(client.get("/users/me/addresses", headers=headers(owner["id"])).json()) == 1
    assert client.get("/users/me/addresses", headers=headers(other["id"])).json() == []
    path = f"/users/me/addresses/{address_id}"
    assert client.delete(path, headers=headers(other["id"])).status_code == 404
    assert client.delete(path, headers=headers(owner["id"])).status_code == 204
    assert client.get("/users/me/addresses", headers=headers(owner["id"])).json() == []


def test_missing_profile(client):
    assert client.get("/users/me", headers=headers(uuid4())).status_code == 404


@pytest.mark.parametrize("data", [{}, {"firstName": " ", "lastName": "Nowak"}, {"firstName": "Anna", "lastName": "N" * 101}])
def test_invalid_input_is_400(client, data):
    user = profile(client)
    response = client.put("/users/me", headers=headers(user["id"]), json=data)
    assert response.status_code == 400
    assert response.json() == {"status": 400, "error": "BAD_REQUEST", "message": "Niepoprawne dane żądania", "requestId": "user-test"}


def test_malformed_json_uuid_and_route(client):
    assert client.post("/users", headers={**headers(roles="SERVICE"), "Content-Type": "application/json"}, content="{").status_code == 400
    assert client.get("/users/not-a-uuid", headers=headers(roles="SERVICE")).status_code == 400
    assert client.get("/missing").status_code == 404
    assert client.patch("/users/me", headers=headers(uuid4()), json={}).status_code == 405


def test_health_and_openapi(client):
    for path in ("/health/live", "/health/ready", "/docs", "/openapi.json"):
        assert client.get(path).status_code == 200
    assert "/users/me" in client.get("/openapi.json").json()["paths"]


def test_invalid_request_id_is_replaced(client):
    response = client.get("/health/live", headers={"X-Request-Id": "not a valid id"})
    assert response.headers["X-Request-Id"] != "not a valid id"
