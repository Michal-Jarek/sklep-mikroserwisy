from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4
from app.config import Settings
from app.main import create_app
from fastapi.testclient import TestClient

SERVICE = {'X-User-Roles': 'SERVICE'}

def test_auth_local_domain_and_exact_idempotency(client):
    body = {'id':str(uuid4()), 'email':'anna@sklep.local', 'firstName':'Anna', 'lastName':'Nowak'}
    assert client.post('/users', json=body, headers=SERVICE).status_code == 201
    assert client.post('/users', json=body, headers=SERVICE).status_code == 200
    assert client.post('/users', json={**body,'email':'other@sklep.local'}, headers=SERVICE).status_code == 409
    assert client.post('/users', json={**body,'id':str(uuid4())}, headers=SERVICE).status_code == 201

def test_concurrent_auth_retries(database_url):
    body = {'id':str(uuid4()), 'email':'race@sklep.local', 'firstName':'Anna', 'lastName':'Nowak'}
    app = create_app(Settings(db_url=database_url, consul_enabled=False))
    with TestClient(app) as client, ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda _: client.post('/users', json=body, headers=SERVICE).status_code, range(6)))
    assert sorted(results) == [200]*5 + [201]

def test_headers_head_slash_and_internal_403(client):
    assert client.post('/users', json={}).status_code == 403
    assert client.head('/health/live').status_code == 200
    assert client.get('/health/live/').status_code == 404
    assert client.get('/users/me', headers=[('X-User-Roles','CUSTOMER'),('X-User-Roles','SERVICE')]).status_code == 400

def test_addresses_keep_creation_order_and_enforce_limit(client):
    user_id = str(uuid4())
    body = {'id':user_id, 'email':'addresses@sklep.local', 'firstName':'Anna', 'lastName':'Nowak'}
    assert client.post('/users', json=body, headers=SERVICE).status_code == 201
    headers = {'X-User-Id':user_id, 'X-User-Roles':'CUSTOMER'}
    address = {'street':'Lipowa 1', 'city':'Warszawa', 'postalCode':'00-001', 'countryCode':'PL'}
    ids = []
    for i in range(50):
        response = client.post('/users/me/addresses', json={**address,'street':f'Lipowa {i}'}, headers=headers)
        assert response.status_code == 201
        ids.append(response.json()['id'])
    assert [a['id'] for a in client.get('/users/me/addresses', headers=headers).json()] == ids
    assert client.post('/users/me/addresses', json=address, headers=headers).status_code == 409
    assert len(client.get('/users/me/addresses', headers=headers).json()) == 50

def test_instance_id_is_stable_per_hostname():
    from socket import gethostname
    assert Settings().instance_id == Settings().instance_id == 'user-service-'+gethostname()
