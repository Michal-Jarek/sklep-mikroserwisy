import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { base64url, exportJWK, exportSPKI, generateKeyPair, type GenerateKeyPairResult, SignJWT } from 'jose';
import type { PinoLogger } from 'nestjs-pino';
import { AppException } from '../common/app-exception';
import { buildAppConfig } from '../config/app-config';
import type { GatewayConfigState } from '../config/gateway-config-state.service';
import { parseGatewayConfig } from '../config/gateway-config';
import type { Instance, ServiceDiscovery } from '../consul/service-discovery.service';
import { AccessControl } from './access-control.service';
import { JWKS_MAX_AGE_MS, JWKS_MIN_INTERVAL_MS, JwksProvider } from './jwks-provider.service';

// The real KV document: the test fails when the file and the K36 matrix drift apart.
const CONFIG = parseGatewayConfig(readFileSync('../../deploy/consul/config/api-gateway.yaml', 'utf8'));
const AUTH: Instance = { id: 'auth-service-1', address: '10.0.0.9', port: 8081 };
const SUB = '0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e';
const KID = 'k1';
// Token times use the real clock (jose checks exp with new Date(), Date.now may be mocked below).
const NOW_SEC = Math.floor(Date.now() / 1000);

let auth: GenerateKeyPairResult;
let other: GenerateKeyPairResult;
let authJwk: Record<string, unknown>;
let otherJwk: Record<string, unknown>;

beforeAll(async () => {
  auth = await generateKeyPair('RS256', { extractable: true });
  other = await generateKeyPair('RS256', { extractable: true });
  authJwk = { ...(await exportJWK(auth.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
  otherJwk = { ...(await exportJWK(other.publicKey)), kid: 'k2', alg: 'RS256', use: 'sig' };
});

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { sub: SUB, roles: ['CUSTOMER'], iss: 'sklep-auth', aud: 'sklep-api', iat: NOW_SEC, exp: NOW_SEC + 900, ...overrides };
}

async function token(
  options: { payload?: Record<string, unknown>; kid?: string | null; key?: GenerateKeyPairResult } = {},
): Promise<string> {
  const { payload = claims(), kid = KID, key = auth } = options;
  const header = kid === null ? { alg: 'RS256' } : { alg: 'RS256', kid };
  return new SignJWT(payload).setProtectedHeader(header).sign(key.privateKey);
}

function part(value: unknown): string {
  return base64url.encode(JSON.stringify(value));
}

function jwks(...keys: unknown[]): Response {
  return new Response(JSON.stringify({ keys }));
}

type Answer = () => Response | Error | Promise<Response>;

function setup(initial: Answer = () => jwks(authJwk), instance: Instance | null = AUTH) {
  let answer = initial;
  const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() => {
    const result = answer();
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  const discovery = { getInstance: jest.fn(() => Promise.resolve(instance)), evict: jest.fn() };
  const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn() };
  const configState = { current: jest.fn(() => CONFIG) };
  const provider = new JwksProvider(
    buildAppConfig({ REDIS_PASSWORD: 'test-redis' }),
    discovery as unknown as ServiceDiscovery,
    logger as unknown as PinoLogger,
  );
  const access = new AccessControl(
    configState as unknown as GatewayConfigState,
    provider,
    logger as unknown as PinoLogger,
  );
  return { access, provider, fetchSpy, logger, configState, set: (next: Answer) => (answer = next) };
}

function segmentsOf(path: string): string[] {
  return path.split('?')[0].slice(1).split('/');
}

/** 200 = authorize let the request through (identity or anonymous), otherwise the status of the AppException. */
async function outcome(access: AccessControl, route: string, authorization: string | undefined): Promise<number> {
  const [method, path] = route.split(' ');
  try {
    await access.authorize(method, segmentsOf(path), authorization);
    return 200;
  } catch (error) {
    if (error instanceof AppException) {
      return error.status;
    }
    throw error;
  }
}

async function rejection(promise: Promise<unknown>): Promise<AppException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppException) {
      return error;
    }
    throw error;
  }
  throw new Error('expected an AppException');
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('AccessControl: K36 matrix on the KV file from the repo', () => {
  const ALL = [200, 200, 200];
  const LOGIN = [401, 200, 200];
  const ADMIN_ONLY = [401, 403, 200];
  const K36: [string, number[]][] = [
    ['GET /products', ALL],
    ['GET /products/p1', ALL],
    ['GET /categories', ALL],
    ['POST /products', ADMIN_ONLY],
    ['PUT /products/p1', ADMIN_ONLY],
    ['PATCH /products/p1', ADMIN_ONLY],
    ['DELETE /products/p1', ADMIN_ONLY],
    ['POST /categories', ADMIN_ONLY],
    ['GET /reviews?productId=p1', ALL],
    ['GET /reviews/summary/p1', ALL],
    ['POST /reviews', LOGIN],
    ['DELETE /reviews/r1', LOGIN],
    ['GET /shipping/methods', ALL],
    ['GET /shipping/methods/courier', ALL],
    ['GET /shipments?orderId=o1', LOGIN],
    ['PATCH /shipments/s1/status', ADMIN_ONLY],
    ['GET /users/me', LOGIN],
    ['PUT /users/me', LOGIN],
    ['GET /users/me/addresses', LOGIN],
    ['POST /users/me/addresses', LOGIN],
    ['DELETE /users/me/addresses/a1', LOGIN],
    [`GET /users/${SUB}`, ADMIN_ONLY],
    // Z26: reading the stock is public; the rule covers one segment only.
    ['GET /inventory/p1', ALL],
    ['HEAD /inventory/p1', ALL],
    ['GET /inventory/p1/x', LOGIN],
    ['PUT /inventory/p1', ADMIN_ONLY],
    ['GET /cart', LOGIN],
    ['POST /cart/items', LOGIN],
    ['PATCH /cart/items/p1', LOGIN],
    ['DELETE /cart/items/p1', LOGIN],
    ['POST /orders', LOGIN],
    ['GET /orders', LOGIN],
    ['GET /orders/o1', LOGIN],
    ['POST /orders/o1/cancel', LOGIN],
    ['GET /notifications/me', LOGIN],
  ];
  // K37 (internal endpoints) and K29 (decoded /orders/purchase%64 and /%75sers): 404 for everyone.
  const BLOCKED = [
    'POST /users',
    `DELETE /cart/${SUB}`,
    'DELETE /cart/items',
    'POST /inventory/reservations',
    'DELETE /inventory/reservations/o1',
    'GET /inventory/reservations',
    'GET /orders/purchased?userId=u&productId=p',
    'GET /orders/purchased/x',
    'GET /orders/purchased',
  ];

  let cust: string;
  let admin: string;

  beforeAll(async () => {
    cust = `Bearer ${await token()}`;
    admin = `Bearer ${await token({ payload: claims({ roles: ['ADMIN'] }) })}`;
  });

  it.each(K36)('%s -> anon/cust/admin %j', async (route, expected) => {
    const { access } = setup();
    const codes = [
      await outcome(access, route, undefined),
      await outcome(access, route, cust),
      await outcome(access, route, admin),
    ];
    expect(codes).toEqual(expected);
  });

  it.each(BLOCKED)('%s -> 404 for anon, cust and admin', async (route) => {
    const { access, fetchSpy } = setup();
    const codes = [
      await outcome(access, route, undefined),
      await outcome(access, route, cust),
      await outcome(access, route, admin),
    ];
    expect(codes).toEqual([404, 404, 404]);
    expect(fetchSpy).not.toHaveBeenCalled(); // blocked before the token is looked at
  });

  it('auth routes are public (any method, also the bare /auth)', async () => {
    const { access } = setup();
    for (const route of ['POST /auth/login', 'POST /auth/refresh', 'DELETE /auth/x/y', 'GET /auth']) {
      expect(await outcome(access, route, undefined)).toBe(200);
      expect(await outcome(access, route, 'Bearer abc.def.ghi')).toBe(200);
    }
  });

  it('notes under 3.3: DELETE /cart/* does not catch DELETE /cart/items/p1; HEAD only where listed', async () => {
    const { access } = setup();
    expect(await outcome(access, 'DELETE /cart/items/p1', undefined)).toBe(401);
    expect(await outcome(access, 'HEAD /products/p1', undefined)).toBe(200);
    expect(await outcome(access, 'HEAD /cart', undefined)).toBe(401);
    expect(await outcome(access, 'HEAD /users/me', cust)).toBe(200);
    expect(await outcome(access, `HEAD /users/${SUB}`, cust)).toBe(403);
  });

  it('returns the identity for a login and null for an anonymous request on a public route', async () => {
    const { access } = setup();
    expect(await access.authorize('GET', ['cart'], cust)).toEqual({ userId: SUB, roles: ['CUSTOMER'] });
    expect(await access.authorize('POST', ['products'], admin)).toEqual({ userId: SUB, roles: ['ADMIN'] });
    expect(await access.authorize('GET', ['products'], undefined)).toBeNull();
  });
});

describe('AccessControl: errors in the team format', () => {
  it('uses the catalog codes and messages (3.5)', async () => {
    const { access } = setup();
    const cust = `Bearer ${await token()}`;
    expect(await rejection(access.authorize('POST', ['users'], cust))).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Not found',
    });
    expect(await rejection(access.authorize('GET', ['cart'], undefined))).toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'Missing or invalid access token',
    });
    expect(await rejection(access.authorize('POST', ['products'], cust))).toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
      message: 'Insufficient role',
    });
  });

  it('answers 503 when the configuration is not loaded', async () => {
    const { access, configState } = setup();
    configState.current.mockReturnValue(null as unknown as typeof CONFIG);
    expect(await rejection(access.authorize('GET', ['products'], undefined))).toMatchObject({
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Service is unavailable, try again later',
    });
  });
});

describe('AccessControl: JWT (decision 13)', () => {
  const BAD_TOKENS: [string, () => Promise<string>][] = [
    ['exp in the past', () => token({ payload: claims({ iat: NOW_SEC - 960, exp: NOW_SEC - 60 }) })],
    ['wrong iss', () => token({ payload: claims({ iss: 'evil' }) })],
    ['wrong aud', () => token({ payload: claims({ aud: 'evil' }) })],
    ['signed with another key', () => token({ key: other })],
    ['unknown kid', () => token({ kid: 'other' })],
    ['no kid', () => token({ kid: null })],
    ['alg none', () => Promise.resolve(`${part({ alg: 'none', kid: KID })}.${part(claims())}.`)],
    [
      'HS256 with the public key PEM as the secret',
      async () =>
        new SignJWT(claims())
          .setProtectedHeader({ alg: 'HS256', kid: KID })
          .sign(new TextEncoder().encode(await exportSPKI(auth.publicKey))),
    ],
    ['sub not a UUID', () => token({ payload: claims({ sub: 'not-a-uuid' }) })],
    ['roles []', () => token({ payload: claims({ roles: [] }) })],
    ['roles [SERVICE]', () => token({ payload: claims({ roles: ['SERVICE'] }) })],
    ['roles not a list', () => token({ payload: claims({ roles: 'CUSTOMER' }) })],
    ['roles with a non-string', () => token({ payload: claims({ roles: ['CUSTOMER', 1] }) })],
    ['no roles', () => token({ payload: claims({ roles: undefined }) })],
    ['no iat', () => token({ payload: claims({ iat: undefined }) })],
    ['no exp', () => token({ payload: claims({ exp: undefined }) })],
    ['no sub', () => token({ payload: claims({ sub: undefined }) })],
  ];

  it.each(BAD_TOKENS)('%s -> 401 on a protected route, anonymous on a public one', async (_name, make) => {
    const { access } = setup();
    const header = `Bearer ${await make()}`;
    expect(await outcome(access, 'GET /cart', header)).toBe(401);
    expect(await access.authorize('GET', ['products'], header)).toBeNull();
  });

  it.each(['Bearer abc.def.ghi', 'Basic dXNlcjpwYXNz', 'Bearer', ''])(
    'header %j -> 401 on a protected route, anonymous on a public one',
    async (header) => {
      const { access } = setup();
      expect(await outcome(access, 'GET /cart', header)).toBe(401);
      expect(await access.authorize('GET', ['products'], header)).toBeNull();
    },
  );

  it('accepts the scheme in lower case', async () => {
    const { access } = setup();
    expect(await access.authorize('GET', ['cart'], `bearer ${await token()}`)).toEqual({ userId: SUB, roles: ['CUSTOMER'] });
  });

  it('drops roles other than CUSTOMER and ADMIN and keeps the order from the token', async () => {
    const { access } = setup();
    const mixed = await token({ payload: claims({ roles: ['CUSTOMER', 'SERVICE'] }) });
    expect(await access.authorize('GET', ['cart'], `Bearer ${mixed}`)).toEqual({ userId: SUB, roles: ['CUSTOMER'] });
    const both = await token({ payload: claims({ roles: ['ADMIN', 'SUPPORT', 'CUSTOMER'] }) });
    expect(await access.authorize('GET', ['cart'], `Bearer ${both}`)).toEqual({ userId: SUB, roles: ['ADMIN', 'CUSTOMER'] });
  });

  it('a valid token on a public route gives the identity (K35)', async () => {
    const { access } = setup();
    expect(await access.authorize('GET', ['products'], `Bearer ${await token()}`)).toEqual({
      userId: SUB,
      roles: ['CUSTOMER'],
    });
  });

  it('logs a rejected token at debug with the reason only (no token, no claims)', async () => {
    const { access, logger } = setup();
    const expired = await token({ payload: claims({ iat: NOW_SEC - 960, exp: NOW_SEC - 60 }) });
    await outcome(access, 'GET /cart', `Bearer ${expired}`);

    expect(logger.debug).toHaveBeenCalledWith({ reason: 'ERR_JWT_EXPIRED' }, 'Access token not accepted');
    const logged = JSON.stringify([logger.debug.mock.calls, logger.info.mock.calls, logger.warn.mock.calls]);
    expect(logged).not.toContain(expired);
    expect(logged).not.toContain(SUB);
  });

  it('no Authorization header is not logged as a rejected token', async () => {
    const { access, logger } = setup();
    await outcome(access, 'GET /cart', undefined);
    await outcome(access, 'GET /products', undefined);
    expect(logger.debug).not.toHaveBeenCalled();
  });
});

describe('AccessControl: JWKS (decision 14)', () => {
  let now = 0;

  beforeEach(() => {
    now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  it('without any keys: 503 on a protected route for a well-formed token, anonymous on a public one, 401 without a token', async () => {
    const { access, provider } = setup(() => new TypeError('fetch failed'));
    provider.onApplicationBootstrap();
    const valid = `Bearer ${await token()}`;

    expect(await rejection(access.authorize('GET', ['cart'], valid))).toMatchObject({
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Service is unavailable, try again later',
    });
    expect(await access.authorize('GET', ['products'], valid)).toBeNull();
    for (const header of [undefined, 'Basic dXNlcjpwYXNz', 'Bearer', 'Bearer abc.def.ghi', `Bearer ${await token({ kid: null })}`]) {
      expect(await outcome(access, 'GET /cart', header)).toBe(401);
    }
  });

  it('without an auth-service instance: 503 on a protected route, no exception from the provider', async () => {
    const { access, fetchSpy } = setup(() => jwks(authJwk), null);
    expect(await outcome(access, 'GET /cart', `Bearer ${await token()}`)).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keys appear after Auth comes back: the next refresh (10 s later) lets the token through', async () => {
    const { access, set } = setup(() => new TypeError('fetch failed'));
    const valid = `Bearer ${await token()}`;
    expect(await outcome(access, 'GET /cart', valid)).toBe(503);

    set(() => jwks(authJwk));
    expect(await outcome(access, 'GET /cart', valid)).toBe(503); // within 10 s: no new request
    now += JWKS_MIN_INTERVAL_MS;
    expect(await outcome(access, 'GET /cart', valid)).toBe(200);
  });

  it('K38: Auth down and keys older than 10 min -> the token is still accepted with the kept keys', async () => {
    const { access, fetchSpy, logger, set } = setup();
    const valid = `Bearer ${await token()}`;
    expect(await outcome(access, 'GET /cart', valid)).toBe(200);

    set(() => new TypeError('fetch failed'));
    now += JWKS_MAX_AGE_MS + JWKS_MIN_INTERVAL_MS;
    expect(await outcome(access, 'GET /cart', valid)).toBe(200);
    now += JWKS_MIN_INTERVAL_MS;
    expect(await outcome(access, 'GET /cart', valid)).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('unknown kid: one refresh and success with the new key (key rotation in Auth)', async () => {
    const { access, fetchSpy, set } = setup();
    expect(await outcome(access, 'GET /cart', `Bearer ${await token()}`)).toBe(200);

    set(() => jwks(authJwk, otherJwk));
    now += JWKS_MIN_INTERVAL_MS;
    const rotated = `Bearer ${await token({ kid: 'k2', key: other })}`;
    expect(await access.authorize('GET', ['cart'], rotated)).toEqual({ userId: SUB, roles: ['CUSTOMER'] });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('another unknown kid within 10 s: no request, 401', async () => {
    const { access, fetchSpy, set } = setup();
    expect(await outcome(access, 'GET /cart', `Bearer ${await token({ kid: 'k2', key: other })}`)).toBe(401);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    set(() => jwks(authJwk, otherJwk));
    now += JWKS_MIN_INTERVAL_MS - 1;
    expect(await outcome(access, 'GET /cart', `Bearer ${await token({ kid: 'k2', key: other })}`)).toBe(401);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('10 concurrent requests with an unknown kid: one JWKS request, all accepted', async () => {
    let release: () => void = () => undefined;
    const published = new Promise<void>((resolve) => (release = resolve));
    const { access, fetchSpy } = setup(() => published.then(() => jwks(authJwk)));
    const valid = `Bearer ${await token()}`;

    const pending = Promise.all(Array.from({ length: 10 }, () => access.authorize('GET', ['cart'], valid)));
    release();

    expect(await pending).toEqual(Array.from({ length: 10 }, () => ({ userId: SUB, roles: ['CUSTOMER'] })));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
