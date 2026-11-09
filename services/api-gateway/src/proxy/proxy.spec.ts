import { jest } from '@jest/globals';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { EventEmitter } from 'node:events';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LoggerModule, type PinoLogger } from 'nestjs-pino';
import { pino } from 'pino';
import { AccessControl, type Identity } from '../access/access-control.service';
import { AppException, ERROR_MESSAGES } from '../common/app-exception';
import { createFastifyAdapter } from '../common/fastify-adapter';
import { loggerModuleParams, REDACTED_PATHS } from '../common/logger';
import type { GatewayConfig } from '../config/gateway-config';
import { GatewayConfigState } from '../config/gateway-config-state.service';
import { type Instance, ServiceDiscovery } from '../consul/service-discovery.service';
import { HealthController } from '../health/health.controller';
import { setupCors } from '../limits/cors';
import { KEY_PREFIX, RATE_LIMIT_REDIS, RateLimiter, type RateLimitRedis } from '../limits/rate-limiter.service';
import { setupRateLimit } from '../limits/setup-rate-limit';
import { GATEWAY_PREFIX, PATHS } from '../routes';
import { setupApp } from '../setup-app';
import { CircuitBreakers } from './circuit-breakers.service';
import { ProxyService } from './proxy.service';
import { setupProxy } from './setup-proxy';
import { type ForwardResult, UpstreamService } from './upstream.service';

const INSTANCE_ID = 'api-gateway-test';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMEOUT_SECONDS = 1;

// Test data: resource names of the routing table (configuration, not endpoints of the Gateway).
const ROUTES = new Map([
  ['products', 'product-service'],
  ['cart', 'cart-service'],
  ['auth', 'auth-service'],
]);
const LOGIN = '/auth/login';
const FRONT = 'http://localhost:5173';

const CONFIG = {
  logLevel: 'info',
  jwt: { issuer: 'sklep-auth', audience: 'sklep-api' },
  proxy: { timeoutSeconds: TIMEOUT_SECONDS },
  routes: ROUTES,
  access: [],
  rateLimit: { global: { max: 300, timeWindowSeconds: 60 }, routes: [] },
  cors: { allowedOrigins: [] },
} satisfies GatewayConfig;

interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

/** Test service: records requests; x-test-status and x-test-delay-ms control the answer. */
function startUpstream(received: Received[]): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      const status = Number(req.headers['x-test-status'] ?? 200);
      const vary = req.headers['x-test-vary'];
      const delay = Number(req.headers['x-test-delay-ms'] ?? 0);
      // A service that opens CORS on its own (N3): the Gateway must not pass it on.
      const cors =
        req.headers['x-test-cors'] === undefined
          ? {}
          : {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Credentials': 'true',
              'Access-Control-Expose-Headers': 'X-Internal',
              'Access-Control-Max-Age': '86400',
            };
      setTimeout(() => {
        if (res.destroyed) {
          return;
        }
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          Server: 'test-upstream',
          'X-Powered-By': 'test-upstream',
          'X-Instance-Id': 'upstream-1',
          'X-Request-Id': 'from-upstream',
          'Content-Security-Policy': 'upstream-policy',
          'Set-Cookie': ['a=1; Path=/x; HttpOnly', 'b=2'],
          'Retry-After': '7',
          ...(vary === undefined ? {} : { Vary: vary }),
          ...cors,
        });
        res.end(JSON.stringify({ status, method: req.method, url: req.url }));
      }, delay).unref();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

/** A port with nothing listening on it (connection refused). */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Plain node:http client: sends the path exactly as given (fetch would normalize "..") and any method. */
function send(
  port: number,
  method: string,
  path: string,
  options: { headers?: Record<string, string | string[]>; body?: Buffer | string; chunked?: boolean } = {},
): Promise<HttpResult> {
  const headers = { ...options.headers };
  if (options.body !== undefined && !options.chunked) {
    // node:http sends a DELETE body without Content-Length otherwise.
    headers['content-length'] = String(Buffer.byteLength(options.body));
  }
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (options.body !== undefined && options.chunked) {
      // Two writes without Content-Length: Transfer-Encoding: chunked.
      const body = Buffer.from(options.body);
      req.write(body.subarray(0, 3));
      req.end(body.subarray(3));
    } else {
      req.end(options.body);
    }
  });
}

/**
 * In-memory Redis for the Redis store of @fastify/rate-limit: the commands it defines count per key and
 * answer with 42 s left in the window (no expiry needed here).
 */
class FakeRedis extends EventEmitter implements RateLimitRedis {
  readonly counters = new Map<string, number>();
  // A slow Redis: every answer comes after this delay.
  delayMs = 0;
  connect = (): Promise<void> => Promise.resolve();
  disconnect = (): void => undefined;
  defineCommand(name: string): void {
    Object.assign(this, {
      [name]: (key: string, ...args: unknown[]) => {
        const callback = args.pop() as (error: Error | null, result: [number, number]) => void;
        const count = (this.counters.get(key) ?? 0) + 1;
        this.counters.set(key, count);
        setTimeout(() => callback(null, [count, 42_000]), this.delayMs);
      },
    });
  }
}

/** Sends a request and destroys the connection after leaveAfterMs, without waiting for an answer. */
function leave(port: number, path: string, leaveAfterMs: number): void {
  const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path, agent: false });
  req.on('error', () => undefined);
  req.end();
  setTimeout(() => req.destroy(), leaveAfterMs);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class FakeDiscovery {
  instances: Instance[] = [];
  private next = 0;

  getInstance = jest.fn((service: string): Promise<Instance | null> => {
    void service;
    if (this.instances.length === 0) {
      return Promise.resolve(null);
    }
    const instance = this.instances[this.next % this.instances.length];
    this.next += 1;
    return Promise.resolve(instance);
  });

  evict = jest.fn((service: string, instance: Instance): void => {
    void service;
    this.instances = this.instances.filter((item) => item.id !== instance.id);
  });

  reset(instances: Instance[]): void {
    this.instances = instances;
    this.next = 0;
    this.getInstance.mockClear();
    this.evict.mockClear();
  }
}

describe('proxy (HTTP flow on a real server)', () => {
  let app: NestFastifyApplication;
  let port: number;
  let upstream: Server;
  let healthy: Instance;
  let refused: Instance;
  let refused2: Instance;
  const received: Received[] = [];
  const logLines: Record<string, unknown>[] = [];
  const discovery = new FakeDiscovery();
  let config: GatewayConfig | null = CONFIG;
  const authorize = jest.fn<AccessControl['authorize']>();
  const redis = new FakeRedis();
  const breakerLogger = { warn: jest.fn(), info: jest.fn() };
  // A fresh set of circuits for every test (a 5xx in one test must not count in another).
  let breakers = new CircuitBreakers(breakerLogger as unknown as PinoLogger);
  const runs: Promise<unknown>[] = [];
  const breakersProxy = {
    rejects: (service: string) => breakers.rejects(service),
    run: (...args: Parameters<CircuitBreakers['run']>) => {
      const promise = breakers.run(...args);
      runs.push(promise);
      return promise;
    },
  };

  const gw = (method: string, path: string, options?: Parameters<typeof send>[3]): Promise<HttpResult> =>
    send(port, method, `${GATEWAY_PREFIX}${path}`, options);

  beforeAll(async () => {
    const started = await startUpstream(received);
    upstream = started.server;
    healthy = { id: 'svc-1', address: '127.0.0.1', port: started.port };
    refused = { id: 'svc-0-down', address: '127.0.0.1', port: await closedPort() };
    refused2 = { id: 'svc-0-down-2', address: '127.0.0.1', port: await closedPort() };

    const logger = pino(
      { level: 'info', base: { service: 'api-gateway' }, redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' } },
      { write: (line: string) => logLines.push(JSON.parse(line) as Record<string, unknown>) },
    );
    const moduleRef = await Test.createTestingModule({
      imports: [LoggerModule.forRoot(loggerModuleParams(logger))],
      controllers: [HealthController],
      providers: [
        ProxyService,
        UpstreamService,
        RateLimiter,
        { provide: RATE_LIMIT_REDIS, useValue: redis },
        { provide: CircuitBreakers, useValue: breakersProxy },
        { provide: GatewayConfigState, useValue: { current: () => config } },
        { provide: ServiceDiscovery, useValue: discovery },
        { provide: AccessControl, useValue: { authorize } },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter(INSTANCE_ID, logger), {
      logger: false,
      bodyParser: false,
    });
    await setupApp(app, logger);
    await setupCors(app);
    await setupRateLimit(app);
    await setupProxy(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = Number(new URL(await app.getUrl()).port);
  });

  afterAll(async () => {
    await app.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  beforeEach(() => {
    config = CONFIG;
    received.length = 0;
    logLines.length = 0;
    discovery.reset([healthy]);
    authorize.mockReset();
    authorize.mockResolvedValue(null);
    redis.counters.clear();
    redis.delayMs = 0;
    breakers = new CircuitBreakers(breakerLogger as unknown as PinoLogger);
    breakerLogger.warn.mockClear();
    runs.length = 0;
  });

  function errorBody(result: HttpResult): Record<string, unknown> {
    return JSON.parse(result.text) as Record<string, unknown>;
  }

  function expectError(result: HttpResult, status: number, error: string, message: string): void {
    expect(result.status).toBe(status);
    expect(errorBody(result)).toEqual({ status, error, message, requestId: result.headers['x-request-id'] });
    expect(result.headers['x-gateway-instance-id']).toBe(INSTANCE_ID);
  }

  describe('order of the steps (guidelines 3.4)', () => {
    it('2: configuration not loaded -> 503 before the method, the path and the route are checked', async () => {
      config = null;
      for (const [method, path] of [
        ['GET', '/products'],
        ['PROPFIND', '/products'],
        ['GET', '/products/../users'],
        ['GET', '/payments'],
        ['GET', ''],
      ]) {
        expectError(await gw(method, path), 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.serviceUnavailable);
      }
      expect(authorize).not.toHaveBeenCalled();
      expect(received).toHaveLength(0);
    });

    it('4: methods outside GET HEAD POST PUT PATCH DELETE -> 405, also OPTIONS and methods unknown to the router', async () => {
      for (const method of ['PROPFIND', 'OPTIONS', 'TRACE', 'MKCOL']) {
        expectError(await gw(method, '/products'), 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      }
      // Fastify itself requires a Content-Type for QUERY (400 in the team format without one).
      expectError(await gw('QUERY', '/products', { headers: { 'content-type': 'text/plain' }, body: 'x' }), 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      expectError(await gw('QUERY', '/products'), 400, 'VALIDATION_ERROR', 'Bad request');
      // Before the path check.
      expect((await gw('PROPFIND', '/products/../users')).status).toBe(405);
      expect(received).toHaveLength(0);
    });

    it('5: a non-canonical path -> 400 before the route (also for an unknown resource)', async () => {
      expectError(await gw('GET', '/payments/a;b'), 400, 'VALIDATION_ERROR', 'Invalid request path');
      expectError(await gw('GET', '/products/%2e%2e/users'), 400, 'VALIDATION_ERROR', 'Invalid request path');
      expect(authorize).not.toHaveBeenCalled();
    });

    it('6: no route -> 404 (exact, case-sensitive first segment); the prefix alone -> 404', async () => {
      for (const path of ['/payments', '/Products', '/product', '', '?x=1']) {
        expectError(await gw('POST', path), 404, 'NOT_FOUND', 'Not found');
      }
      expect(authorize).not.toHaveBeenCalled();
      expect(discovery.getInstance).not.toHaveBeenCalled();
    });

    it('7: authorize gets the method, decoded segments and the raw Authorization header; its exceptions pass', async () => {
      authorize.mockRejectedValueOnce(new AppException(401, 'UNAUTHORIZED', ERROR_MESSAGES.unauthorized));
      const unauthorized = await gw('GET', '/%63art/items', { headers: { authorization: 'Bearer abc' } });
      expectError(unauthorized, 401, 'UNAUTHORIZED', 'Missing or invalid access token');
      expect(unauthorized.headers['www-authenticate']).toBe('Bearer');
      expect(authorize).toHaveBeenCalledWith('GET', ['cart', 'items'], 'Bearer abc');

      authorize.mockRejectedValueOnce(new AppException(404, 'NOT_FOUND', ERROR_MESSAGES.notFound));
      expectError(await gw('DELETE', '/cart/u1'), 404, 'NOT_FOUND', 'Not found');
      authorize.mockRejectedValueOnce(new AppException(403, 'FORBIDDEN', ERROR_MESSAGES.forbidden));
      expectError(await gw('POST', '/products'), 403, 'FORBIDDEN', 'Insufficient role');
      authorize.mockRejectedValueOnce(new AppException(503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.serviceUnavailable));
      expectError(await gw('GET', '/cart'), 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.serviceUnavailable);
      // Access is decided before an instance is looked up.
      expect(discovery.getInstance).not.toHaveBeenCalled();
      expect(received).toHaveLength(0);
    });

    it('9: no healthy instance -> 503 after the access check', async () => {
      discovery.reset([]);
      expectError(await gw('GET', '/products'), 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.serviceUnavailable);
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(discovery.getInstance).toHaveBeenCalledWith('product-service');
    });

    it('unexpected error inside the Gateway -> 500 INTERNAL_ERROR without details', async () => {
      authorize.mockRejectedValueOnce(new Error('internal detail'));
      const result = await gw('GET', '/products');
      expectError(result, 500, 'INTERNAL_ERROR', 'Internal server error');
      expect(result.text).not.toContain('internal detail');
    });
  });

  describe('canonical path (K28, E3)', () => {
    it.each([
      '/products/../users/me',
      '/products/%2e%2e/users/me',
      '/products/%2E%2E',
      '/products/.',
      '/products/a%2Fb',
      '/products/a%5Cb',
      '/products//a',
      '/products/',
      '/products/a;b=1',
      '/products/%zz',
      '/products/a%00b',
      '/products/a%20b',
      '/products/%C4%85',
      '/',
      '/products/%',
      '/products/a%2',
    ])('%s -> 400, nothing reaches the service', async (path) => {
      expectError(await gw('GET', path), 400, 'VALIDATION_ERROR', 'Invalid request path');
      expect(received).toHaveLength(0);
    });
  });

  describe('forwarding', () => {
    it('sends the canonical path without the prefix and the raw query (K14)', async () => {
      await gw('GET', '/products/abc-1?q=a%20b&sort=price');
      await gw('GET', '/%70roducts/abc-2');
      await gw('GET', '/products?q=%zz&x=%C4%85');
      await gw('GET', '/products/~x/a.b/%41');
      expect(received.map((item) => item.url)).toEqual([
        '/products/abc-1?q=a%20b&sort=price',
        '/products/abc-2',
        '/products?q=%zz&x=%C4%85',
        '/products/~x/a.b/A',
      ]);
    });

    it('passes the response of the service unchanged except Server and X-Powered-By; Gateway headers win', async () => {
      for (const status of [200, 404, 429, 500, 503]) {
        received.length = 0;
        const result = await gw('GET', '/products', { headers: { 'x-test-status': String(status), 'x-request-id': 'rid-1' } });
        expect(result.status).toBe(status);
        expect(JSON.parse(result.text)).toEqual({ status, method: 'GET', url: '/products' });
        expect(result.headers['content-type']).toBe('application/json; charset=utf-8');
        expect(result.headers['set-cookie']).toEqual(['a=1; Path=/x; HttpOnly', 'b=2']);
        expect(result.headers['retry-after']).toBe('7');
        expect(result.headers['x-instance-id']).toBe('upstream-1');
        expect(result.headers.server).toBeUndefined();
        expect(result.headers['x-powered-by']).toBeUndefined();
        expect(result.headers['x-request-id']).toBe('rid-1');
        expect(result.headers['x-gateway-instance-id']).toBe(INSTANCE_ID);
        expect(result.headers['content-security-policy']).toBe("default-src 'none';frame-ancestors 'none'");
        expect(result.headers['x-content-type-options']).toBe('nosniff');
        // No retry after a 5xx response (reply-from would retry GET after 503).
        expect(received).toHaveLength(1);
      }
    });

    it('HEAD reaches the service as HEAD and the client gets the headers without a body (E1)', async () => {
      const result = await gw('HEAD', '/products');
      expect(result.status).toBe(200);
      expect(result.text).toBe('');
      expect(received.map((item) => [item.method, item.body.length])).toEqual([['HEAD', 0]]);
    });

    it('builds the request headers of guidelines 3.2 (anonymous)', async () => {
      await gw('GET', '/products', {
        headers: {
          Authorization: 'Bearer token',
          'X-User-Id': ['00000000-0000-0000-0000-000000000001', 'second'],
          'x-USER-roles': 'ADMIN,SERVICE',
          'X-User-Email': 'a@b.c',
          'X-Forwarded-For': '1.2.3.4',
          'X-Forwarded-Host': 'evil',
          Forwarded: 'for=1.2.3.4',
          'X-Real-IP': '1.2.3.4',
          Connection: 'x-hop, keep-alive',
          'X-Hop': '1',
          'Keep-Alive': 'timeout=5',
          TE: 'trailers',
          'Proxy-Authorization': 'Basic x',
          Cookie: 'a=1',
          Accept: 'application/json',
          'X-Request-Id': 'rid-headers',
          'X-Custom': 'kept',
        },
      });
      const headers = received[0].headers;
      expect(Object.keys(headers).filter((name) => name.startsWith('x-user-'))).toEqual([]);
      for (const name of ['authorization', 'forwarded', 'x-real-ip', 'x-forwarded-host', 'x-hop', 'keep-alive', 'te', 'proxy-authorization']) {
        expect(headers[name]).toBeUndefined();
      }
      expect(headers['x-forwarded-for']).toBe('127.0.0.1');
      expect(headers['x-request-id']).toBe('rid-headers');
      expect(headers.cookie).toBe('a=1');
      expect(headers.accept).toBe('application/json');
      expect(headers['x-custom']).toBe('kept');
    });

    it('Expect: 100-continue -> the answer of the service, which never gets Expect; nothing counted as a failure (W1)', async () => {
      for (let i = 0; i < 10; i += 1) {
        expect((await gw('GET', '/products', { headers: { expect: '100-continue' } })).status).toBe(200);
        const post = await gw('POST', '/auth/logout', { headers: { expect: '100-continue', 'content-type': 'application/json' }, body: '{}' });
        expect(post.status).toBe(200);
      }
      expect(received).toHaveLength(20);
      expect(received.map((item) => item.headers.expect)).toEqual(Array(20).fill(undefined));
      expect(received[1].body.toString('utf8')).toBe('{}');
      expect(breakers.rejects('product-service')).toBe(false);
      expect(breakers.rejects('auth-service')).toBe(false);
      expect(logLines.filter((line) => line.msg === 'Request to the service failed')).toEqual([]);
    });

    it('sets X-User-Id and X-User-Roles for an identity and a new X-Request-Id for an invalid one', async () => {
      const identity: Identity = { userId: '0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e', roles: ['CUSTOMER', 'ADMIN'] };
      authorize.mockResolvedValue(identity);
      const result = await gw('GET', '/cart', { headers: { 'X-User-Id': 'fake', 'X-Request-Id': 'zly id!' } });
      const headers = received[0].headers;
      expect(headers['x-user-id']).toBe(identity.userId);
      expect(headers['x-user-roles']).toBe('CUSTOMER,ADMIN');
      expect(headers['x-request-id']).toMatch(UUID_V4);
      expect(headers['x-request-id']).toBe(result.headers['x-request-id']);
    });

    it.each([
      ['application/json; charset=utf-8', '{ "productId" :"p1",  "quantity":2 }'],
      ['application/json', '{zly json'],
      ['application/x-www-form-urlencoded', 'a=1&b=%20'],
      ['text/plain; charset=utf-8', 'non-ASCII \u017c\u00f3\u0142w\r\n'],
    ])('passes the body byte for byte with its Content-Type: %s (K17)', async (contentType, payload) => {
      authorize.mockResolvedValue({ userId: 'u', roles: ['CUSTOMER'] });
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        received.length = 0;
        expect((await gw(method, '/cart/items', { headers: { 'content-type': contentType }, body: payload })).status).toBe(200);
        expect(received[0].method).toBe(method);
        expect(received[0].headers['content-type']).toBe(contentType);
        expect(received[0].body.toString('utf8')).toBe(payload);
        expect(received[0].headers['content-length']).toBe(String(Buffer.byteLength(payload)));
      }
    });

    it('sends a body without Content-Type as application/octet-stream, an empty POST with length 0', async () => {
      await gw('POST', '/cart/items', { body: Buffer.from([0, 1, 2, 255]) });
      await gw('POST', '/cart/items');
      expect(received[0].headers['content-type']).toBe('application/octet-stream');
      expect([...received[0].body]).toEqual([0, 1, 2, 255]);
      expect(received[1].headers['content-length']).toBe('0');
      expect(received[1].headers['content-type']).toBeUndefined();
      expect(received[1].body.length).toBe(0);
    });

    it('turns a chunked body into one with Content-Length, the same bytes (E5)', async () => {
      const payload = '{"chunked":true,"text":"abcdefghij"}';
      await gw('POST', '/cart/items', { headers: { 'content-type': 'application/json' }, body: payload, chunked: true });
      expect(received[0].body.toString('utf8')).toBe(payload);
      expect(received[0].headers['content-length']).toBe(String(payload.length));
      expect(received[0].headers['transfer-encoding']).toBeUndefined();
    });
  });

  describe('errors of the service connection (decision 11)', () => {
    it('GET: no connection -> evict and one retry on another instance', async () => {
      discovery.reset([refused, healthy]);
      const result = await gw('GET', '/products');
      expect(result.status).toBe(200);
      expect(received).toHaveLength(1);
      expect(discovery.evict).toHaveBeenCalledWith('product-service', refused);
      expect(discovery.getInstance).toHaveBeenCalledTimes(2);
    });

    it('GET: no connection to two instances -> 502 after exactly one retry, both evicted', async () => {
      discovery.reset([refused, refused2]);
      expectError(await gw('GET', '/products'), 502, 'BAD_GATEWAY', 'Service is not reachable');
      expect(discovery.getInstance).toHaveBeenCalledTimes(2);
      expect(discovery.evict.mock.calls.map(([, instance]) => instance.id)).toEqual([refused.id, refused2.id]);
      const failures = logLines.filter((line) => line.msg === 'Request to the service failed');
      expect(failures.map((line) => [line.upstream, line.reason])).toEqual([
        [`127.0.0.1:${refused.port}`, 'ECONNREFUSED'],
        [`127.0.0.1:${refused2.port}`, 'ECONNREFUSED'],
      ]);
      expect(received).toHaveLength(0);
    });

    it('GET: no connection and no other instance -> 502', async () => {
      discovery.reset([refused]);
      expectError(await gw('GET', '/products'), 502, 'BAD_GATEWAY', 'Service is not reachable');
      expect(discovery.getInstance).toHaveBeenCalledTimes(2);
      expect(discovery.evict).toHaveBeenCalledTimes(1);

      // HEAD is retried like GET (the error response has no body).
      discovery.reset([refused, healthy]);
      expect((await gw('HEAD', '/products')).status).toBe(200);
      expect(received.map((item) => item.method)).toEqual(['HEAD']);
    });

    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s: no connection -> 502 and evict, without a retry', async (method) => {
      discovery.reset([refused, healthy]);
      expectError(await gw(method, '/cart/items', { body: '{}' }), 502, 'BAD_GATEWAY', 'Service is not reachable');
      expect(discovery.getInstance).toHaveBeenCalledTimes(1);
      expect(discovery.evict).toHaveBeenCalledWith('cart-service', refused);
      expect(received).toHaveLength(0);
    });

    it('no response within proxy.timeoutSeconds -> 504 without a retry', async () => {
      discovery.reset([healthy, healthy]);
      const started = Date.now();
      const result = await gw('GET', '/products', { headers: { 'x-test-delay-ms': '4000' } });
      const elapsed = Date.now() - started;
      expectError(result, 504, 'GATEWAY_TIMEOUT', 'Service did not respond in time');
      // undici timers have a resolution of about 0.5 s.
      expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_SECONDS * 1000 - 100);
      expect(elapsed).toBeLessThan(TIMEOUT_SECONDS * 1000 + 1500);
      expect(received).toHaveLength(1);
      expect(discovery.evict).not.toHaveBeenCalled();
    });

    it('a request the HTTP client refuses to build (rejected) -> 400 Bad request: no evict, no retry, not counted (W1)', async () => {
      // undici rejects it before sending (e.g. UND_ERR_NOT_SUPPORTED, UND_ERR_INVALID_ARG); simulated per attempt.
      // attempt() is private: reached through a narrower view of the service.
      const upstream = app.get<UpstreamService, { attempt: () => Promise<ForwardResult> }>(UpstreamService);
      const attempt = jest.spyOn(upstream, 'attempt').mockResolvedValue({ kind: 'rejected', upstream: `127.0.0.1:${healthy.port}` });
      try {
        discovery.reset([healthy, healthy]);
        for (let i = 0; i < 12; i += 1) {
          expectError(await gw('GET', '/products'), 400, 'VALIDATION_ERROR', 'Bad request');
        }
        expect(attempt).toHaveBeenCalledTimes(12);
        expect(discovery.getInstance).toHaveBeenCalledTimes(12);
        expect(discovery.evict).not.toHaveBeenCalled();
        expect(breakers.rejects('product-service')).toBe(false);
      } finally {
        attempt.mockRestore();
      }
      expect((await gw('GET', '/products')).status).toBe(200);
    });

    it('a slower answer within the limit passes', async () => {
      const result = await gw('GET', '/products', { headers: { 'x-test-delay-ms': '300' } });
      expect(result.status).toBe(200);
    });
  });

  describe('logs (decision 25)', () => {
    it('the "request completed" line has targetService, upstream, userId, statusCode and responseTime', async () => {
      authorize.mockResolvedValue({ userId: 'user-1', roles: ['CUSTOMER'] });
      await gw('GET', '/cart', {
        headers: {
          'x-request-id': 'log-test',
          cookie: 'session=abc',
          authorization: 'Bearer secret-token',
          'proxy-authorization': 'Basic c2VrcmV0OnRlc3Q=',
        },
      });
      const line = logLines.find((item) => item.requestId === 'log-test' && item.msg === 'request completed');
      expect(line).toMatchObject({
        service: 'api-gateway',
        targetService: 'cart-service',
        upstream: `127.0.0.1:${healthy.port}`,
        userId: 'user-1',
        res: expect.objectContaining({ statusCode: 200 }),
        responseTime: expect.any(Number),
      });
      const all = JSON.stringify(logLines);
      expect(all).not.toContain('secret-token');
      expect(all).not.toContain('session=abc');
      expect(all).not.toContain('c2VrcmV0OnRlc3Q=');
    });

    it('the line of a 5xx answer has the error type and message without a stack (N6)', async () => {
      await gw('GET', '/products', { headers: { 'x-request-id': 'log-503', 'x-test-status': '503' } });
      discovery.reset([]);
      await gw('GET', '/products', { headers: { 'x-request-id': 'log-no-instance' } });
      for (const [requestId, status] of [['log-503', 503], ['log-no-instance', 503]] as const) {
        const line = logLines.find((item) => item.requestId === requestId && item.msg === 'request errored');
        expect(line).toMatchObject({ res: expect.objectContaining({ statusCode: status }) });
        expect(line?.err).toEqual({ type: 'Error', message: `failed with status code ${status}` });
      }
    });

    it('an exception of the Gateway (500) is still logged with its stack (N6)', async () => {
      authorize.mockRejectedValueOnce(new Error('internal detail'));
      await gw('GET', '/products', { headers: { 'x-request-id': 'log-500' } });
      const unhandled = logLines.find((item) => item.requestId === 'log-500' && item.msg === 'Unhandled error');
      expect(unhandled?.err).toMatchObject({ type: 'Error', message: 'internal detail', stack: expect.stringContaining('internal detail') });
      const completed = logLines.find((item) => item.requestId === 'log-500' && item.msg === 'request errored');
      expect(completed?.err).toEqual({ type: 'Error', message: 'failed with status code 500' });
    });

    it('a POST with a body is logged with its fields too, an anonymous request without userId', async () => {
      await gw('POST', '/cart/items', { headers: { 'x-request-id': 'log-post', 'content-type': 'application/json' }, body: '{"a":1}' });
      const line = logLines.find((item) => item.requestId === 'log-post' && item.msg === 'request completed');
      expect(line).toMatchObject({ targetService: 'cart-service', upstream: `127.0.0.1:${healthy.port}` });
      expect(line).not.toHaveProperty('userId');
      expect(JSON.stringify(logLines)).not.toContain('"a":1');
    });
  });

  describe('rate limits (step 3, decision 20)', () => {
    const limited = (max: number, routes: GatewayConfig['rateLimit']['routes'] = []): GatewayConfig => ({
      ...CONFIG,
      rateLimit: { global: { max, timeWindowSeconds: 60 }, routes },
    });

    function expectTooMany(result: HttpResult): void {
      expectError(result, 429, 'TOO_MANY_REQUESTS', 'Too many requests, try again later');
      expect(result.headers['retry-after']).toBe('42');
      // A Gateway response: no X-Instance-Id, the Gateway and helmet headers are there.
      expect(result.headers['x-instance-id']).toBeUndefined();
      expect(result.headers['x-request-id']).toBeDefined();
      expect(result.headers['content-security-policy']).toBe("default-src 'none';frame-ancestors 'none'");
      // The contract has Retry-After only (3.5), no headers of the plugin.
      expect(Object.keys(result.headers).filter((name) => name.includes('ratelimit'))).toEqual([]);
    }

    it('configuration not loaded -> 503 before the limits (Redis not asked)', async () => {
      config = null;
      expect((await gw('GET', '/products')).status).toBe(503);
      expect(redis.counters.size).toBe(0);
    });

    it('429 before the method check: 3 x PROPFIND -> 405, the 4th -> 429 (E3)', async () => {
      config = limited(3);
      for (let i = 0; i < 3; i += 1) {
        expect((await gw('PROPFIND', '/products')).status).toBe(405);
      }
      expectTooMany(await gw('PROPFIND', '/products'));
    });

    it('429 before the path check: 3 x a%2Fb -> 400, the 4th -> 429 (E3)', async () => {
      config = limited(3);
      for (let i = 0; i < 3; i += 1) {
        expect((await gw('GET', '/products/a%2Fb')).status).toBe(400);
      }
      expectTooMany(await gw('GET', '/products/a%2Fb'));
    });

    it('429 before the route, the token check and the service', async () => {
      config = limited(1);
      expect((await gw('GET', '/payments')).status).toBe(404);
      expectTooMany(await gw('GET', '/payments'));
      expectTooMany(await gw('GET', '/cart', { headers: { authorization: 'Bearer abc' } }));
      expect(authorize).not.toHaveBeenCalled();
      expect(received).toHaveLength(0);
    });

    it('route limit on the canonical path (also percent-encoded) with its own key; a non-canonical path counts only globally', async () => {
      config = limited(300, [{ method: 'POST', path: LOGIN, max: 2, timeWindowSeconds: 60 }]);
      expect((await gw('POST', LOGIN, { body: '{}' })).status).toBe(200);
      expect((await gw('POST', '/%61uth/login', { body: '{}' })).status).toBe(200);
      expectTooMany(await gw('POST', LOGIN, { body: '{}' }));
      // Other endpoints still pass: the login limit has its own counter.
      expect((await gw('GET', '/products')).status).toBe(200);
      expect((await gw('POST', `${LOGIN};x`, { body: '{}' })).status).toBe(400);
      expect((await gw('GET', LOGIN)).status).toBe(200);
      expect([...redis.counters.entries()]).toEqual([
        [`${KEY_PREFIX}global:127.0.0.1`, 6],
        [`${KEY_PREFIX}POST:${LOGIN}:127.0.0.1`, 3],
      ]);
    });

    it('health endpoints are not limited', async () => {
      config = limited(1);
      for (let i = 0; i < 3; i += 1) {
        expect((await send(port, 'GET', PATHS.healthLive)).status).toBe(200);
        expect((await send(port, 'GET', PATHS.healthReady)).status).toBe(200);
      }
      expect(redis.counters.size).toBe(0);
    });
  });

  describe('circuit breaker (steps 8-10, decision 12)', () => {
    it('10 x 502 open the circuit of the service: then 503 without Consul and the service; another service works (K47, E4)', async () => {
      for (let i = 0; i < 10; i += 1) {
        expect((await gw('GET', '/products', { headers: { 'x-test-status': '502' } })).status).toBe(502);
      }
      expect(breakerLogger.warn).toHaveBeenCalledWith({ targetService: 'product-service', state: 'open' }, 'Circuit breaker opened');
      received.length = 0;
      discovery.getInstance.mockClear();
      expectError(await gw('GET', '/products'), 503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.serviceUnavailable);
      expect(discovery.getInstance).not.toHaveBeenCalled();
      expect(received).toHaveLength(0);
      expect((await gw('GET', '/cart')).status).toBe(200);
    });

    it('500 and 503 of a service do not open it: 20 x 500, 20 x 503, then 200 (K47, Z27)', async () => {
      for (const status of [500, 503]) {
        for (let i = 0; i < 20; i += 1) {
          expect((await gw('GET', '/products', { headers: { 'x-test-status': String(status) } })).status).toBe(status);
        }
      }
      expect((await gw('GET', '/products')).status).toBe(200);
    });

    it('502 and 504 of the Gateway count as failures', async () => {
      discovery.reset([refused]);
      for (let i = 0; i < 10; i += 1) {
        discovery.instances = [refused];
        expect((await gw('POST', '/cart/items', { body: '{}' })).status).toBe(502);
      }
      discovery.reset([healthy]);
      expect((await gw('GET', '/cart')).status).toBe(503);
      expect(discovery.getInstance).not.toHaveBeenCalled();
    });

    it('4xx responses do not open it (K48)', async () => {
      for (let i = 0; i < 20; i += 1) {
        expect((await gw('GET', '/products', { headers: { 'x-test-status': '404' } })).status).toBe(404);
      }
      expect((await gw('GET', '/products')).status).toBe(200);
    });

    it('no instance is not counted: 12 x 503 without an instance, then the service answers (E5)', async () => {
      discovery.reset([]);
      for (let i = 0; i < 12; i += 1) {
        expect((await gw('GET', '/products')).status).toBe(503);
      }
      expect(runs).toHaveLength(0);
      discovery.reset([healthy]);
      expect((await gw('GET', '/products')).status).toBe(200);
    });

    it('a client that leaves during the token check settles as aborted, the service gets nothing (W2)', async () => {
      authorize.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(null), 300)));
      leave(port, `${GATEWAY_PREFIX}/products`, 100);
      await sleep(500);
      expect(runs).toHaveLength(1);
      await expect(runs[0]).resolves.toMatchObject({ kind: 'aborted' });
      expect(received).toHaveLength(0);
    }, 3000);

    it('a client that leaves while the rate limit waits for Redis settles as aborted, the service gets nothing (W2)', async () => {
      redis.delayMs = 300;
      leave(port, `${GATEWAY_PREFIX}/products`, 100);
      await sleep(500);
      expect(runs).toHaveLength(1);
      await expect(runs[0]).resolves.toMatchObject({ kind: 'aborted' });
      expect(received).toHaveLength(0);
    }, 3000);

    it('a client that leaves before the retry of GET settles as aborted, the second instance gets nothing (W2)', async () => {
      discovery.reset([refused, healthy]);
      const pick = discovery.getInstance.getMockImplementation()!;
      discovery.getInstance
        .mockImplementationOnce(pick)
        .mockImplementationOnce((service) => sleep(300).then(() => pick(service)));
      leave(port, `${GATEWAY_PREFIX}/products`, 100);
      await sleep(500);
      expect(runs).toHaveLength(1);
      await expect(runs[0]).resolves.toMatchObject({ kind: 'aborted' });
      expect(discovery.evict).toHaveBeenCalledTimes(1);
      expect(discovery.getInstance).toHaveBeenCalledTimes(2);
      expect(received).toHaveLength(0);
    }, 3000);

    it('a client that leaves before the answer settles the request as aborted (pitfall 5a)', async () => {
      const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path: `${GATEWAY_PREFIX}/products`, headers: { 'x-test-delay-ms': '3000' }, agent: false });
      req.on('error', () => undefined);
      req.end();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(runs).toHaveLength(1);
      req.destroy();
      const started = Date.now();
      await expect(runs[0]).resolves.toMatchObject({ kind: 'aborted' });
      expect(Date.now() - started).toBeLessThan(500);
      expect(breakers.rejects('product-service')).toBe(false);
    });
  });

  describe('HTTP server (N1)', () => {
    it('a request must arrive within 30 s (headers and body), checked every second -> 408 from clientErrorHandler', () => {
      const server = app.getHttpServer() as Server & { connectionsCheckingInterval: number };
      expect(server.requestTimeout).toBe(30_000);
      expect(server.headersTimeout).toBe(30_000);
      expect(server.connectionsCheckingInterval).toBe(1_000);
    });
  });

  describe('CORS (decision 21) and Vary (pitfall 5b)', () => {
    const withOrigins: () => GatewayConfig = () => ({ ...CONFIG, cors: { allowedOrigins: [FRONT] } });
    const preflight = { origin: FRONT, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,authorization' };

    function corsHeaders(result: HttpResult): string[] {
      return Object.keys(result.headers).filter((name) => name.startsWith('access-control-'));
    }

    it('empty list (default): no CORS headers, OPTIONS -> 405 (K12)', async () => {
      const result = await gw('GET', '/products', { headers: { origin: FRONT } });
      expect(result.status).toBe(200);
      expect(corsHeaders(result)).toEqual([]);
      const options = await gw('OPTIONS', '/products', { headers: preflight });
      expectError(options, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      expect(corsHeaders(options)).toEqual([]);
    });

    it('an origin from the list gets the CORS headers on the proxied response', async () => {
      config = withOrigins();
      const result = await gw('GET', '/products', { headers: { origin: FRONT } });
      expect(result.status).toBe(200);
      expect(result.headers['access-control-allow-origin']).toBe(FRONT);
      expect(result.headers['access-control-allow-credentials']).toBe('true');
      expect(result.headers['access-control-expose-headers']).toBe('X-Request-Id, X-Instance-Id, X-Gateway-Instance-Id, Retry-After');
    });

    it('a preflight from the list -> 204 with methods, headers and max age, before the proxy (no limit, no service)', async () => {
      config = withOrigins();
      const result = await gw('OPTIONS', '/products', { headers: preflight });
      expect(result.status).toBe(204);
      expect(result.headers['access-control-allow-origin']).toBe(FRONT);
      expect(result.headers['access-control-allow-methods']).toBe('GET, HEAD, POST, PUT, PATCH, DELETE');
      expect(result.headers['access-control-allow-headers']).toBe('Content-Type, Authorization, X-Request-Id');
      expect(result.headers['access-control-max-age']).toBe('600');
      expect(result.headers['x-request-id']).toBeDefined();
      expect(result.headers['content-security-policy']).toBeDefined();
      expect(received).toHaveLength(0);
    });

    it('an origin outside the list: no CORS headers, its preflight -> 405', async () => {
      config = withOrigins();
      const evil = 'http://evil.example';
      expect(corsHeaders(await gw('GET', '/products', { headers: { origin: evil } }))).toEqual([]);
      const options = await gw('OPTIONS', '/products', { headers: { ...preflight, origin: evil } });
      expect(options.status).toBe(405);
      expect(corsHeaders(options)).toEqual([]);
    });

    it('Access-Control-* of the service never reach the client; the Gateway values stay (N3)', async () => {
      const closed = await gw('GET', '/products', { headers: { origin: FRONT, 'x-test-cors': '1' } });
      expect(closed.status).toBe(200);
      expect(corsHeaders(closed)).toEqual([]);

      config = withOrigins();
      const open = await gw('GET', '/products', { headers: { origin: FRONT, 'x-test-cors': '1' } });
      expect(open.headers['access-control-allow-origin']).toBe(FRONT);
      expect(open.headers['access-control-allow-credentials']).toBe('true');
      expect(open.headers['access-control-expose-headers']).toBe('X-Request-Id, X-Instance-Id, X-Gateway-Instance-Id, Retry-After');
      expect(open.headers['access-control-max-age']).toBeUndefined();
      expect(corsHeaders(await gw('GET', '/products', { headers: { origin: 'http://evil.example', 'x-test-cors': '1' } }))).toEqual([]);
    });

    it('Vary of the service is merged with Vary: Origin of the Gateway, not replaced', async () => {
      config = withOrigins();
      const merged = await gw('GET', '/products', { headers: { origin: FRONT, 'x-test-vary': 'Accept-Encoding' } });
      expect(merged.headers.vary).toBe('Origin, Accept-Encoding');
      const only = await gw('GET', '/products', { headers: { 'x-test-vary': 'Accept-Language' } });
      expect(only.headers.vary).toBe('Origin, Accept-Language');
      expect((await gw('GET', '/products')).headers.vary).toBe('Origin');
    });
  });
});
