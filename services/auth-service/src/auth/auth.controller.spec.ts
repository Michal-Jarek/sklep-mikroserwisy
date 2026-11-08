import { jest } from '@jest/globals';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AppException } from '../common/app-exception';
import { createFastifyAdapter } from '../common/fastify-adapter';
import { registerFastifyPlugins } from '../common/fastify-plugins';
import { PATHS, REFRESH_COOKIE_PATH } from '../routes';
import { createOpenApiDocument, setupApp } from '../setup-app';
import { AuthController } from './auth.controller';
import type { LoginRequest, RegisterRequest } from './auth.dto';
import { AuthService, type Session } from './auth.service';
import { JwksController } from './jwks.controller';
import { TokenService } from './token.service';

const JWK = { kty: 'RSA', n: 'modulus', e: 'AQAB', kid: 'kid-1', alg: 'RS256', use: 'sig' };
const TOKENS = { accessToken: 'a.b.c', tokenType: 'Bearer' as const, expiresIn: 900 };
const LOGIN = { email: 'anna@example.com', password: 'correct-horse-42' };

/** Attributes of a Set-Cookie header, names in lower case: {"refresh_token": value, "max-age": "0", ...}. */
function cookieAttributes(header: string | null): Record<string, string> {
  return Object.fromEntries(
    (header ?? '').split(';').map((part) => {
      const [name, ...value] = part.trim().split('=');
      return [name.toLowerCase(), value.join('=')];
    }),
  );
}

// A real HTTP server on a random port (see setup-app.spec.ts); the services are replaced.
describe('auth endpoints (HTTP)', () => {
  let app: NestFastifyApplication;
  let baseUrl: string;
  const register = jest.fn<(request: RegisterRequest, requestId: string) => Promise<unknown>>();
  const login = jest.fn<(request: LoginRequest) => Promise<Session>>();
  const refresh = jest.fn<(token: string | undefined) => Promise<Session>>();
  const logout = jest.fn<(token: string | undefined) => Promise<void>>();

  function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController, JwksController],
      providers: [
        { provide: AuthService, useValue: { register, login, refresh, logout } },
        { provide: TokenService, useValue: { jwks: () => ({ keys: [JWK] }) } },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter('auth-service-test'), {
      logger: false,
    });
    await registerFastifyPlugins(app);
    setupApp(app, { error: jest.fn() });
    await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it(`POST ${PATHS.register}: 201, normalized input and the request id passed on`, async () => {
    const created = { id: 'id-1', email: 'anna@example.com', firstName: 'Anna', lastName: 'Nowak', roles: ['CUSTOMER'] };
    register.mockResolvedValue(created);

    const response = await post(
      PATHS.register,
      { email: ' Anna@Example.com ', password: 'correct-horse-42', firstName: ' Anna ', lastName: 'Nowak' },
      { 'x-request-id': 'reg-1' },
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(created);
    expect(register).toHaveBeenCalledWith(
      { email: 'anna@example.com', password: 'correct-horse-42', firstName: 'Anna', lastName: 'Nowak' },
      'reg-1',
    );
  });

  it(`POST ${PATHS.register}: 400 VALIDATION_ERROR without calling the service`, async () => {
    const response = await post(PATHS.register, { email: 'anna@example.com', password: 'short' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ status: 400, error: 'VALIDATION_ERROR' });
    expect(register).not.toHaveBeenCalled();
  });

  it(`POST ${PATHS.login}: 200 (not 201), access token in the body, refresh token only in the cookie`, async () => {
    login.mockResolvedValue({ response: TOKENS, refreshToken: 'refresh-value' });

    const response = await post(PATHS.login, { email: 'Anna@Example.com', password: 'correct-horse-42' }, { 'x-forwarded-for': '10.1.0.1' });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual(TOKENS);
    expect(text).not.toContain('refresh-value');
    expect(login).toHaveBeenCalledWith({ email: 'anna@example.com', password: 'correct-horse-42' });
    // Decision 17: HttpOnly; Secure; SameSite=Strict; Path of the Gateway; Max-Age=604800.
    expect(cookieAttributes(response.headers.get('set-cookie'))).toEqual({
      refresh_token: 'refresh-value',
      'max-age': '604800',
      path: REFRESH_COOKIE_PATH,
      httponly: '',
      secure: '',
      samesite: 'Strict',
    });
  });

  it(`POST ${PATHS.login}: no cookie when the login fails`, async () => {
    login.mockRejectedValue(new AppException(401, 'INVALID_CREDENTIALS', 'Invalid email or password'));

    const response = await post(PATHS.login, LOGIN, { 'x-forwarded-for': '10.1.0.2' });

    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it(`POST ${PATHS.login}: 429 TOO_MANY_ATTEMPTS from the account lock keeps Retry-After`, async () => {
    login.mockRejectedValue(new AppException(429, 'TOO_MANY_ATTEMPTS', 'Too many failed login attempts, try again later', 845));

    const response = await post(PATHS.login, LOGIN, { 'x-forwarded-for': '10.1.0.3' });

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('845');
    expect(await response.json()).toMatchObject({ status: 429, error: 'TOO_MANY_ATTEMPTS' });
  });

  it(`POST ${PATHS.refresh}: reads the cookie (empty body) and sets the new one`, async () => {
    refresh.mockResolvedValue({ response: TOKENS, refreshToken: 'new-value' });

    const response = await fetch(`${baseUrl}${PATHS.refresh}`, { method: 'POST', headers: { cookie: 'other=1; refresh_token=old-value' } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(TOKENS);
    expect(refresh).toHaveBeenCalledWith('old-value');
    expect(cookieAttributes(response.headers.get('set-cookie'))).toMatchObject({ refresh_token: 'new-value', 'max-age': '604800', path: REFRESH_COOKIE_PATH });
  });

  it(`POST ${PATHS.refresh}: 401 UNAUTHORIZED clears the cookie`, async () => {
    refresh.mockRejectedValue(new AppException(401, 'UNAUTHORIZED', 'Invalid or expired refresh token'));

    const response = await fetch(`${baseUrl}${PATHS.refresh}`, { method: 'POST' });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ status: 401, error: 'UNAUTHORIZED', requestId: response.headers.get('x-request-id') });
    expect(refresh).toHaveBeenCalledWith(undefined);
    expect(cookieAttributes(response.headers.get('set-cookie'))).toMatchObject({ refresh_token: '', 'max-age': '0', path: REFRESH_COOKIE_PATH });
  });

  it(`POST ${PATHS.refresh}: other errors (e.g. database down) keep the cookie`, async () => {
    refresh.mockRejectedValue(new Error('connection refused'));

    const response = await fetch(`${baseUrl}${PATHS.refresh}`, { method: 'POST', headers: { cookie: 'refresh_token=old-value' } });

    expect(response.status).toBe(500);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it(`POST ${PATHS.logout}: 204 with the cookie cleared (Max-Age=0, same path), with or without a cookie`, async () => {
    logout.mockResolvedValue(undefined);

    const withCookie = await fetch(`${baseUrl}${PATHS.logout}`, { method: 'POST', headers: { cookie: 'refresh_token=some-value' } });
    const withoutCookie = await fetch(`${baseUrl}${PATHS.logout}`, { method: 'POST' });

    for (const response of [withCookie, withoutCookie]) {
      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');
      expect(cookieAttributes(response.headers.get('set-cookie'))).toMatchObject({
        refresh_token: '',
        'max-age': '0',
        path: REFRESH_COOKIE_PATH,
        httponly: '',
        secure: '',
        samesite: 'Strict',
      });
    }
    expect(logout.mock.calls).toEqual([['some-value'], [undefined]]);
  });

  describe(`IP limit on POST ${PATHS.login} (5 per 60 s, trustProxy for private networks)`, () => {
    beforeEach(() => {
      login.mockRejectedValue(new AppException(401, 'INVALID_CREDENTIALS', 'Invalid email or password'));
    });

    async function loginFrom(forwardedFor: string) {
      return post(PATHS.login, LOGIN, { 'x-forwarded-for': forwardedFor, 'x-request-id': 'limit-test' });
    }

    it('the 6th request from one IP gets 429 TOO_MANY_REQUESTS in the team format, before the service', async () => {
      for (let i = 0; i < 5; i += 1) {
        expect((await loginFrom('10.2.0.1')).status).toBe(401);
      }

      const response = await loginFrom('10.2.0.1');

      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({
        status: 429,
        error: 'TOO_MANY_REQUESTS',
        message: expect.any(String),
        requestId: 'limit-test',
      });
      const retryAfter = Number(response.headers.get('retry-after'));
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(60);
      expect(response.headers.get('x-request-id')).toBe('limit-test');
      expect(response.headers.get('x-instance-id')).toBe('auth-service-test');
      expect(login).toHaveBeenCalledTimes(5);
    });

    it('another IP is counted separately', async () => {
      for (let i = 0; i < 6; i += 1) {
        await loginFrom('10.3.0.1');
      }
      expect((await loginFrom('10.3.0.2')).status).toBe(401);
    });

    it('X-Forwarded-For is followed only through trusted hops: a spoofed entry before a public address is ignored', async () => {
      // 127.0.0.1 (test client) and 10.x are trusted, 203.0.113.7 is not: the client is 203.0.113.7.
      for (let i = 1; i <= 5; i += 1) {
        expect((await loginFrom(`10.4.0.${i}, 203.0.113.7`)).status).toBe(401);
      }
      expect((await loginFrom('10.4.0.6, 203.0.113.7')).status).toBe(429);
      expect((await loginFrom('203.0.113.8')).status).toBe(401);
    });

    it('registration and refresh have no limit', async () => {
      register.mockResolvedValue({ id: 'id-1', email: 'a@example.com', firstName: 'A', lastName: 'B', roles: ['CUSTOMER'] });
      refresh.mockRejectedValue(new AppException(401, 'UNAUTHORIZED', 'Invalid or expired refresh token'));
      const headers = { 'x-forwarded-for': '10.5.0.1' };

      for (let i = 0; i < 7; i += 1) {
        const response = await post(PATHS.register, { email: `user${i}@example.com`, password: 'correct-horse-42', firstName: 'A', lastName: 'B' }, headers);
        expect(response.status).toBe(201);
        expect((await fetch(`${baseUrl}${PATHS.refresh}`, { method: 'POST', headers })).status).toBe(401);
      }
    });
  });

  it(`GET ${PATHS.jwks}: 200 with the public key`, async () => {
    const response = await fetch(`${baseUrl}${PATHS.jwks}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ keys: [JWK] });
  });

  it('describes the endpoints in OpenAPI', () => {
    expect(Object.keys(createOpenApiDocument(app).paths)).toEqual(
      expect.arrayContaining([PATHS.register, PATHS.login, PATHS.refresh, PATHS.logout, PATHS.jwks]),
    );
  });
});
