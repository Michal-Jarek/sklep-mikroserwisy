import { describe, expect, it } from 'vitest';
import { mockAccessToken } from './handlers/auth';
import { accessFor, encodeBase64Url } from './http';
import { setupMockServer } from './node';
import { SEED_IDS } from './seed';
import { call, customerToken } from './test-utils';

setupMockServer();

function tokenWith(claims: Record<string, unknown>): string {
  return [
    encodeBase64Url('{"alg":"RS256"}'),
    encodeBase64Url(JSON.stringify(claims)),
    'c2ln',
  ].join('.');
}

describe('access rules of the Gateway', () => {
  it('maps paths like deploy/consul/config/api-gateway.yaml', () => {
    expect(accessFor('POST', '/auth/login')).toBe('public');
    expect(accessFor('POST', '/users')).toBe('blocked');
    expect(accessFor('DELETE', '/cart/' + SEED_IDS.customer)).toBe('blocked');
    expect(accessFor('DELETE', '/cart/items/' + SEED_IDS.products.regular)).toBe('authenticated');
    expect(accessFor('POST', '/inventory/reservations')).toBe('blocked');
    expect(accessFor('GET', '/orders/purchased')).toBe('blocked');
    expect(accessFor('GET', '/users/me')).toBe('authenticated');
    expect(accessFor('GET', '/users/' + SEED_IDS.customer)).toBe('ADMIN');
    expect(accessFor('GET', '/products')).toBe('public');
    expect(accessFor('PUT', '/products/x')).toBe('ADMIN');
    expect(accessFor('GET', '/inventory/x')).toBe('public');
    expect(accessFor('PUT', '/inventory/x')).toBe('ADMIN');
    expect(accessFor('PATCH', '/shipments/x/status')).toBe('ADMIN');
    expect(accessFor('GET', '/shipments')).toBe('authenticated');
    expect(accessFor('POST', '/reviews')).toBe('authenticated');
  });

  it('answers 401 UNAUTHORIZED without a token on a route that requires login', async () => {
    const result = await call<{ status: number; error: string; requestId: string }>('GET', '/cart', {
      headers: { 'X-Request-Id': 'test-req-1' },
    });
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ status: 401, error: 'UNAUTHORIZED', requestId: 'test-req-1' });
    expect(result.headers.get('WWW-Authenticate')).toBe('Bearer');
  });

  it('answers 401 for an expired token and for a token of another issuer', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const expired = tokenWith({ sub: SEED_IDS.customer, roles: ['CUSTOMER'], iss: 'sklep-auth', aud: 'sklep-api', iat: past - 900, exp: past });
    const otherIssuer = tokenWith({ sub: SEED_IDS.customer, roles: ['CUSTOMER'], iss: 'other', aud: 'sklep-api', iat: past, exp: past + 900 });
    expect((await call('GET', '/orders', { token: expired })).status).toBe(401);
    expect((await call('GET', '/orders', { token: otherIssuer })).status).toBe(401);
    expect((await call('GET', '/orders', { token: 'not-a-token' })).status).toBe(401);
  });

  it('answers 403 FORBIDDEN for a customer on an ADMIN route and 401 without a token', async () => {
    const forbidden = await call<{ error: string }>('PUT', `/inventory/${SEED_IDS.products.regular}`, {
      token: customerToken(),
      body: { quantity: 1 },
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toBe('FORBIDDEN');
    expect((await call('DELETE', `/products/${SEED_IDS.products.regular}`)).status).toBe(401);
  });

  it('lets public routes work with an expired token, as anonymous', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const expired = tokenWith({ sub: SEED_IDS.customer, roles: ['CUSTOMER'], iss: 'sklep-auth', aud: 'sklep-api', iat: past - 900, exp: past });
    expect((await call('GET', '/products', { token: expired })).status).toBe(200);
  });

  it('accepts a valid token for ADMIN routes', async () => {
    const admin = mockAccessToken(SEED_IDS.admin, ['ADMIN']);
    expect((await call('GET', `/inventory/${SEED_IDS.products.regular}`, { token: admin })).status).toBe(200);
    expect((await call('PUT', `/inventory/${SEED_IDS.products.regular}`, { token: admin, body: { quantity: 51 } })).status).toBe(200);
  });

  it('answers 400 VALIDATION_ERROR for a path parameter that is not a UUID', async () => {
    const result = await call<{ error: string }>('GET', '/products/123');
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('VALIDATION_ERROR');
  });
});
