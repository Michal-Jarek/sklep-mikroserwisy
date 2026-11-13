import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { AccessTokenClaims, Address, ErrorBody, Page, ProductSummary, TokenResponse, UserProfile } from '../api/types';
import { mockControls } from './controls';
import { loadState } from './db';
import { mockAccessToken } from './handlers/auth';
import { server, setupMockServer } from './node';
import { MOCK_ACCOUNTS, SEED_IDS } from './seed';
import { adminToken, call, customerToken, login } from './test-utils';

setupMockServer();

function claimsOf(token: string): AccessTokenClaims {
  const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '='))) as AccessTokenClaims;
}

describe('mock Auth', () => {
  it('logs in with the mock accounts and issues a token like Auth', async () => {
    const result = await call<TokenResponse>('POST', '/auth/login', { body: MOCK_ACCOUNTS.customer });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
    expect(result.body.accessToken.split('.')).toHaveLength(3);
    const claims = claimsOf(result.body.accessToken);
    expect(claims).toMatchObject({ sub: SEED_IDS.customer, roles: ['CUSTOMER'], iss: 'sklep-auth', aud: 'sklep-api' });
    expect(claims.exp - claims.iat).toBe(900);
    expect(claimsOf(await login('admin')).roles).toEqual(['ADMIN']);
  });

  it('answers 401 INVALID_CREDENTIALS for a wrong password and 400 for bad input', async () => {
    const wrong = await call<ErrorBody>('POST', '/auth/login', { body: { email: MOCK_ACCOUNTS.customer.email, password: 'zle-haslo' } });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe('INVALID_CREDENTIALS');
    expect((await call('POST', '/auth/login', { body: { email: 'bez-malpy', password: 'x' } })).status).toBe(400);
    expect((await call('POST', '/auth/login', { body: { ...MOCK_ACCOUNTS.customer, roles: ['ADMIN'] } })).status).toBe(400);
  });

  it('rotates the session on refresh and ends it on logout', async () => {
    expect((await call('POST', '/auth/refresh')).status).toBe(401);
    const first = await login('customer');
    const refreshed = await call<TokenResponse>('POST', '/auth/refresh');
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.accessToken).not.toBe(first);
    expect(claimsOf(refreshed.body.accessToken).sub).toBe(SEED_IDS.customer);
    expect(loadState().session).toEqual({ userId: SEED_IDS.customer, rotation: 1 });

    expect((await call('POST', '/auth/logout')).status).toBe(204);
    const after = await call<ErrorBody>('POST', '/auth/refresh');
    expect(after.status).toBe(401);
    expect(after.body.error).toBe('UNAUTHORIZED');
    expect((await call('POST', '/auth/logout')).status).toBe(204);
  });

  it('registers without tokens, creates the profile and rejects a taken e-mail', async () => {
    const body = { email: ' Anna@Example.com ', password: 'Ąę-haslo-1', firstName: 'Anna', lastName: 'Nowak' };
    const created = await call<{ id: string; email: string; roles: string[] }>('POST', '/auth/register', { body });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ email: 'anna@example.com', roles: ['CUSTOMER'] });
    expect(created.body).not.toHaveProperty('accessToken');
    const token = mockAccessToken(created.body.id, ['CUSTOMER']);
    expect((await call<UserProfile>('GET', '/users/me', { token })).body.firstName).toBe('Anna');

    const taken = await call<ErrorBody>('POST', '/auth/register', { body: { ...body, email: 'ANNA@example.com' } });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toBe('EMAIL_TAKEN');
  });

  it.each([
    ['short password', { password: 'krotkie' }],
    ['password over 72 bytes', { password: 'ą'.repeat(37) }],
    ['control character in name', { firstName: 'An\nna' }],
    ['empty last name', { lastName: '' }],
  ])('rejects registration with %s', async (_case, change) => {
    const body = { email: 'nowy@sklep.test', password: 'Dobre-haslo-1', firstName: 'Nowy', lastName: 'Klient', ...change };
    expect((await call('POST', '/auth/register', { body })).status).toBe(400);
  });
});

describe('mock User', () => {
  it('returns and updates the profile of the customer', async () => {
    const me = await call<UserProfile>('GET', '/users/me', { token: customerToken() });
    expect(me.body).toEqual({ id: SEED_IDS.customer, firstName: 'Jan', lastName: 'Kowalski', email: 'klient@sklep.test' });
    const updated = await call<UserProfile>('PUT', '/users/me', { token: customerToken(), body: { firstName: ' Janusz ', lastName: 'Kowalski' } });
    expect(updated.body.firstName).toBe('Janusz');
    expect((await call('PUT', '/users/me', { token: customerToken(), body: { firstName: 'J' } })).status).toBe(400);
  });

  it('answers 404 for ADMIN without a profile', async () => {
    const result = await call<ErrorBody>('GET', '/users/me', { token: adminToken() });
    expect(result.status).toBe(404);
    expect(result.body.error).toBe('NOT_FOUND');
  });

  it('creates a placeholder profile for an unknown CUSTOMER account (real Auth in list mode)', async () => {
    const token = mockAccessToken('12345678-1234-4123-8123-123456789abc', ['CUSTOMER']);
    const me = await call<UserProfile>('GET', '/users/me', { token });
    expect(me.status).toBe(200);
    expect(me.body.id).toBe('12345678-1234-4123-8123-123456789abc');
  });

  it('adds, lists and deletes own addresses only', async () => {
    const body = { street: 'ul. Nowa 2', city: 'Kraków', postalCode: '30-001', countryCode: 'PL' };
    const created = await call<Address>('POST', '/users/me/addresses', { token: customerToken(), body });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject(body);
    const list = await call<Address[]>('GET', '/users/me/addresses', { token: customerToken() });
    expect(list.body.map((a) => a.id)).toEqual([SEED_IDS.address, created.body.id]);
    expect((await call('POST', '/users/me/addresses', { token: customerToken(), body: { ...body, countryCode: 'POL' } })).status).toBe(400);

    const strangerToken = mockAccessToken('12345678-1234-4123-8123-123456789abc', ['CUSTOMER']);
    expect((await call('DELETE', `/users/me/addresses/${created.body.id}`, { token: strangerToken })).status).toBe(404);
    expect((await call('DELETE', `/users/me/addresses/${created.body.id}`, { token: customerToken() })).status).toBe(204);
    expect((await call('DELETE', `/users/me/addresses/${created.body.id}`, { token: customerToken() })).status).toBe(404);
  });
});

describe('window.__mocks controls', () => {
  it('fails the next requests to a resource `times` times with the default D7 code', async () => {
    mockControls.failNext('products', 503, { times: 2 });
    const first = await call<ErrorBody>('GET', '/products');
    expect(first.status).toBe(503);
    expect(first.body).toMatchObject({ status: 503, error: 'SERVICE_UNAVAILABLE' });
    expect((await call('GET', '/products')).status).toBe(503);
    expect((await call('GET', '/products')).status).toBe(200);
    expect((await call('GET', '/categories')).status).toBe(200);
  });

  it('uses the given error and Retry-After, 429 gets 30 s by default', async () => {
    mockControls.failNext('auth', 429, { error: 'TOO_MANY_ATTEMPTS', retryAfter: 840 });
    const locked = await call<ErrorBody>('POST', '/auth/login', { body: MOCK_ACCOUNTS.customer });
    expect(locked.status).toBe(429);
    expect(locked.body.error).toBe('TOO_MANY_ATTEMPTS');
    expect(locked.headers.get('Retry-After')).toBe('840');

    mockControls.failNext('auth', 429);
    const limited = await call<ErrorBody>('POST', '/auth/login', { body: MOCK_ACCOUNTS.customer });
    expect(limited.body.error).toBe('TOO_MANY_REQUESTS');
    expect(limited.headers.get('Retry-After')).toBe('30');
    expect((await call('POST', '/auth/login', { body: MOCK_ACCOUNTS.customer })).status).toBe(200);
  });

  it('with `method` fails only requests with that method, others do not count', async () => {
    const token = customerToken();
    mockControls.failNext('orders', 409, { error: 'ORDER_NOT_CANCELLABLE', method: 'POST' });

    expect((await call('GET', `/orders/${SEED_IDS.orders.paid}`, { token })).status).toBe(200);
    const cancelled = await call<ErrorBody>('POST', `/orders/${SEED_IDS.orders.paid}/cancel`, { token });
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.error).toBe('ORDER_NOT_CANCELLABLE');
    expect(loadState().failures).toEqual({});
  });

  it('reset brings back the seed data without session and planned errors', async () => {
    await login('customer');
    await call('DELETE', `/products/${SEED_IDS.products.regular}`, { token: adminToken() });
    mockControls.failNext('orders', 500);
    mockControls.reset();
    expect(loadState().session).toBeNull();
    expect(loadState().failures).toEqual({});
    expect((await call('GET', `/products/${SEED_IDS.products.regular}`)).status).toBe(200);
  });

  it('lets a single test replace a handler with server.use', async () => {
    server.use(http.get('/api/v1/products', () => HttpResponse.json({ items: [], page: 1, size: 20, total: 0 })));
    expect((await call<Page<ProductSummary>>('GET', '/products')).body.total).toBe(0);
  });
});
