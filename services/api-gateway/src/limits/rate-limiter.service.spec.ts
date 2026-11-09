import { jest } from '@jest/globals';
import { fastify as createFastify, type FastifyInstance, type FastifyRequest } from 'fastify';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { PinoLogger } from 'nestjs-pino';
import { AppException, ERROR_MESSAGES } from '../common/app-exception';
import type { GatewayConfig } from '../config/gateway-config';
import { KEY_PREFIX, RateLimiter, type RateLimitRedis, retryAfterSeconds } from './rate-limiter.service';

// Test data: limits as in deploy/consul/config/api-gateway.yaml (configuration, not endpoints of the Gateway).
const LOGIN = '/auth/login';
const REGISTER = '/auth/register';
const LIMITS: GatewayConfig['rateLimit'] = {
  global: { max: 300, timeWindowSeconds: 60 },
  routes: [
    { method: 'POST', path: LOGIN, max: 5, timeWindowSeconds: 60 },
    { method: 'POST', path: REGISTER, max: 10, timeWindowSeconds: 60 },
  ],
};

type Callback = (error: Error | null, result?: [number, number]) => void;

/**
 * In-memory Redis for the Redis store of @fastify/rate-limit: the commands it defines with defineCommand
 * behave like its fixed-window script (count; the first hit starts the window, later hits get the time
 * left). "failure" makes every command fail like ioredis does (stopped or hanging Redis).
 */
class FakeRedis extends EventEmitter implements RateLimitRedis {
  now = 0;
  failure: Error | null = null;
  readonly counters = new Map<string, { count: number; expiresAt: number }>();
  readonly commands: unknown[][] = [];
  readonly defined: string[] = [];

  connect = jest.fn(() => Promise.resolve());
  disconnect = jest.fn();

  defineCommand(name: string, definition: { numberOfKeys: number; lua: string }): void {
    expect(definition.numberOfKeys).toBe(1);
    this.defined.push(name);
    Object.assign(this, { [name]: (...args: unknown[]) => this.run(name, args) });
  }

  private run(name: string, args: unknown[]): void {
    const callback = args.pop() as Callback;
    this.commands.push([name, ...args]);
    const [key, windowMs] = args as [string, number];
    queueMicrotask(() => {
      if (this.failure) {
        callback(this.failure);
        return;
      }
      let counter = this.counters.get(key);
      if (!counter || counter.expiresAt <= this.now) {
        counter = { count: 0, expiresAt: this.now + windowMs };
        this.counters.set(key, counter);
      }
      counter.count += 1;
      callback(null, [counter.count, counter.count === 1 ? windowMs : counter.expiresAt - this.now]);
    });
  }
}

/**
 * The fields of a Fastify request read by RateLimiter (ip, method) and by the limiters of the plugin
 * (routeOptions.config in applyRateLimit, our keyGenerator). Tests call check() like the proxy does in step 3,
 * without inject (light-my-request loads the ESM-only "cookie" with require, which Jest cannot do on Node 22).
 */
function requestFrom(ip: string, method: string): FastifyRequest {
  return { ip, method, routeOptions: { config: {} } } as unknown as FastifyRequest;
}

/** RateLimiter with the plugin registered on a real Fastify instance and a fake Redis. */
async function createLimiter() {
  const redis = new FakeRedis();
  const logger = { warn: jest.fn(), info: jest.fn() };
  const limiter = new RateLimiter(redis, logger as unknown as PinoLogger);
  const app: FastifyInstance = createFastify();
  await limiter.register(app);

  /** 200 or the thrown error. */
  async function check(ip: string, method: string, path: string | null, limits = LIMITS): Promise<number | AppException> {
    try {
      await limiter.check(requestFrom(ip, method), path, limits);
      return 200;
    } catch (error) {
      return error as AppException;
    }
  }

  async function codes(count: number, method: string, path: string | null, ip = '10.0.0.1'): Promise<number[]> {
    const result: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const outcome = await check(ip, method, path);
      result.push(typeof outcome === 'number' ? outcome : outcome.status);
    }
    return result;
  }

  return { redis, logger, limiter, app, check, codes };
}

const ECONNREFUSED = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

describe('RateLimiter (decision 20, @fastify/rate-limit)', () => {
  it('global limit: max requests pass, the next one gets 429 TOO_MANY_REQUESTS with Retry-After', async () => {
    const { redis, check, codes } = await createLimiter();
    expect(await codes(300, 'GET', '/products')).toEqual(Array(300).fill(200));
    redis.now = 15_500;
    const error = await check('10.0.0.1', 'GET', '/products');
    expect(error).toBeInstanceOf(AppException);
    expect(error).toMatchObject({ status: 429, code: 'TOO_MANY_REQUESTS', message: ERROR_MESSAGES.tooManyRequests, retryAfterSeconds: 45 });
  });

  it('counts in the Redis store of the library: key = prefix + keyGenerator, window in milliseconds', async () => {
    const { redis, check } = await createLimiter();
    expect(redis.defined).toEqual(['rateLimit', 'rateLimitRead']);
    await check('10.0.0.1', 'GET', '/products');
    // Arguments of the store: key, window, max, continueExceeding, exponentialBackoff.
    expect(redis.commands).toEqual([['rateLimit', `${KEY_PREFIX}global:10.0.0.1`, 60_000, 300, false, false]]);
  });

  it('the counter starts again when the window ends', async () => {
    const { redis, codes } = await createLimiter();
    await codes(300, 'GET', '/products');
    expect(await codes(1, 'GET', '/products')).toEqual([429]);
    redis.now = 60_000;
    expect(await codes(1, 'GET', '/products')).toEqual([200]);
  });

  it('counts per client IP', async () => {
    const { codes } = await createLimiter();
    expect(await codes(6, 'POST', LOGIN, '10.0.0.1')).toEqual([200, 200, 200, 200, 200, 429]);
    expect(await codes(1, 'POST', LOGIN, '10.0.0.2')).toEqual([200]);
  });

  it('route limits on top of the global one, each limit with its own key (K42, E2)', async () => {
    const { redis, codes } = await createLimiter();
    expect(await codes(6, 'POST', LOGIN)).toEqual([200, 200, 200, 200, 200, 429]);
    // The login limit is exhausted, the global one is not: other requests still pass.
    expect(await codes(1, 'GET', '/products')).toEqual([200]);
    expect(await codes(11, 'POST', REGISTER)).toEqual([...Array(10).fill(200), 429]);
    expect([...redis.counters.entries()].map(([key, counter]) => [key, counter.count])).toEqual([
      [`${KEY_PREFIX}global:10.0.0.1`, 18],
      [`${KEY_PREFIX}POST:${LOGIN}:10.0.0.1`, 6],
      [`${KEY_PREFIX}POST:${REGISTER}:10.0.0.1`, 11],
    ]);
  });

  it('a route limit needs the exact method and canonical path; a non-canonical path counts only globally', async () => {
    const { redis, check } = await createLimiter();
    await check('10.0.0.1', 'GET', LOGIN);
    await check('10.0.0.1', 'POST', `${LOGIN}/x`);
    await check('10.0.0.1', 'POST', '/auth');
    await check('10.0.0.1', 'POST', '/auth/Login');
    await check('10.0.0.1', 'POST', null);
    expect([...redis.counters.keys()]).toEqual([`${KEY_PREFIX}global:10.0.0.1`]);
  });

  it('the global limit is checked first: when it is exceeded the route counter is not touched', async () => {
    const { redis, check } = await createLimiter();
    const limits = { ...LIMITS, global: { max: 1, timeWindowSeconds: 60 } };
    await check('10.0.0.1', 'POST', LOGIN, limits);
    expect(await check('10.0.0.1', 'POST', LOGIN, limits)).toMatchObject({ status: 429 });
    expect(redis.counters.get(`${KEY_PREFIX}POST:${LOGIN}:10.0.0.1`)?.count).toBe(1);
  });

  it('a different configuration gets new limiters (max and window from it)', async () => {
    const { check } = await createLimiter();
    const strict = { ...LIMITS, global: { max: 1, timeWindowSeconds: 30 } };
    expect(await check('10.0.0.1', 'GET', '/products', strict)).toBe(200);
    expect(await check('10.0.0.1', 'GET', '/products', strict)).toMatchObject({ status: 429, retryAfterSeconds: 30 });
    expect(await check('10.0.0.1', 'GET', '/products', LIMITS)).toBe(200);
  });

  it('only check() counts: the plugin adds no limit and no headers to routes (global: false), on a real server', async () => {
    const { app, redis, limiter } = await createLimiter();
    const limits = { ...LIMITS, global: { max: 1, timeWindowSeconds: 60 } };
    app.get('/without-limit', () => 'done');
    app.get('/limited', async (request, reply) => {
      try {
        await limiter.check(request, '/products', limits);
        return 'done';
      } catch (error) {
        return reply.code((error as AppException).status).send('limited');
      }
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      const statuses: number[] = [];
      for (const path of ['/without-limit', '/without-limit', '/without-limit', '/limited', '/limited']) {
        const response = await fetch(`${base}${path}`);
        statuses.push(response.status);
        expect([...response.headers.keys()].filter((name) => name.includes('ratelimit'))).toEqual([]);
      }
      expect(statuses).toEqual([200, 200, 200, 200, 429]);
      // Only the two requests of /limited reached Redis, with the real client IP in the key.
      expect(redis.commands.map((command) => command[1])).toEqual([`${KEY_PREFIX}global:127.0.0.1`, `${KEY_PREFIX}global:127.0.0.1`]);
    } finally {
      await app.close();
    }
  });

  it('Redis unavailable: every request passes, one warning; when it is back one info and the limits apply', async () => {
    const { redis, logger, codes } = await createLimiter();
    redis.failure = new Error("Stream isn't writeable and enableOfflineQueue options is false");
    expect(await codes(20, 'POST', LOGIN)).toEqual(Array(20).fill(200));
    // ioredis also emits "error" on every reconnect attempt.
    redis.emit('error', ECONNREFUSED);
    redis.emit('error', Object.assign(new Error('getaddrinfo ENOTFOUND redis-gateway'), { code: 'ENOTFOUND' }));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toBe('Redis for rate limits is unavailable, requests pass without a limit');

    redis.failure = null;
    redis.emit('ready');
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0][0]).toBe('Redis for rate limits is available again, limits apply');
    expect(await codes(6, 'POST', LOGIN)).toEqual([200, 200, 200, 200, 200, 429]);

    redis.emit('error', ECONNREFUSED);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('test-redis');
  });

  it('no answer of Redis to the global check: the route limit is skipped, one wait instead of two (S3)', async () => {
    const { redis, check } = await createLimiter();
    // Down (ioredis fails at once) and hanging (commandTimeout: the command fails after 2 s) end the same way:
    // skipOnError lets the request pass with ttl 0, and the route limit is not asked.
    for (const failure of [new Error("Stream isn't writeable"), new Error('Command timed out')]) {
      redis.commands.length = 0;
      redis.failure = failure;
      expect(await check('10.0.0.1', 'POST', LOGIN)).toBe(200);
      expect(redis.commands.map((call) => call[1])).toEqual([`${KEY_PREFIX}global:10.0.0.1`]);
    }
    expect(redis.counters.size).toBe(0);
  });

  it('the route limit is skipped only when this request got no answer, not because of an earlier failure', async () => {
    const { redis, check } = await createLimiter();
    // An earlier connection error: the limiter is marked unavailable, but this request gets answers again.
    redis.emit('error', ECONNREFUSED);
    await check('10.0.0.1', 'POST', LOGIN);
    expect(redis.commands.map((call) => call[1])).toEqual([`${KEY_PREFIX}global:10.0.0.1`, `${KEY_PREFIX}POST:${LOGIN}:10.0.0.1`]);
  });

  it('a successful command after a failed one (no reconnect, e.g. a command timeout) logs the return once', async () => {
    const { redis, logger, check } = await createLimiter();
    redis.failure = new Error('Command timed out');
    await check('10.0.0.1', 'GET', '/products');
    redis.failure = null;
    await check('10.0.0.1', 'GET', '/products');
    await check('10.0.0.1', 'GET', '/products');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toEqual({ reason: 'Command timed out' });
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('connects on module init without throwing and disconnects on shutdown', async () => {
    const { limiter, redis } = await createLimiter();
    redis.connect.mockRejectedValueOnce(ECONNREFUSED);
    expect(() => limiter.onModuleInit()).not.toThrow();
    await Promise.resolve();
    limiter.onApplicationShutdown();
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('retryAfterSeconds', () => {
  it.each([
    [59_001, 60, 60],
    [60_000, 60, 60],
    [120_000, 60, 60],
    [45_000, 60, 45],
    [1, 60, 1],
    [0, 60, 1],
    [-1, 60, 1],
  ])('ttl %i ms, window %i s -> %i', (ttlMs, window, expected) => {
    expect(retryAfterSeconds(ttlMs, window)).toBe(expected);
  });
});
