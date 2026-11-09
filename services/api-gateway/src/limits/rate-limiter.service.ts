import fastifyRateLimit, { type FastifyRateLimitStore, type FastifyRateLimitStoreCtor } from '@fastify/rate-limit';
import RedisStore from '@fastify/rate-limit/store/RedisStore';
import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppException, ERROR_MESSAGES } from '../common/app-exception';
import type { GatewayConfig } from '../config/gateway-config';

// Injection token of the Redis client (redis-gateway); tests provide a fake one.
export const RATE_LIMIT_REDIS = Symbol('RATE_LIMIT_REDIS');

/** The part of the ioredis client used here and by the Redis store of @fastify/rate-limit. */
export interface RateLimitRedis {
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'ready', listener: () => void): unknown;
  connect(): Promise<void>;
  defineCommand(name: string, definition: { numberOfKeys: number; lua: string }): void;
  disconnect(): void;
}

// Every limit has its own key: <prefix><limit>:<client IP>, e.g. rate-limit:global:172.23.0.1 and
// rate-limit:POST:/auth/login:172.23.0.1 (decision 20, K42: the login and the global limit never share a counter).
export const KEY_PREFIX = 'rate-limit:';

type RateLimitConfig = GatewayConfig['rateLimit'];
type Limit = RateLimitConfig['global'];
type RouteLimit = RateLimitConfig['routes'][number];
type Limiter = ReturnType<FastifyInstance['createRateLimit']>;

interface Limiters {
  config: RateLimitConfig;
  global: Limiter;
  routes: { limit: RouteLimit; limiter: Limiter }[];
}

/** Seconds until the window ends, 1..window (Retry-After). */
export function retryAfterSeconds(ttlMs: number, timeWindowSeconds: number): number {
  return Math.min(timeWindowSeconds, Math.max(1, Math.ceil(ttlMs / 1000)));
}

/**
 * Rate limits shared by all Gateway instances (decision 20, Z24): @fastify/rate-limit with its fixed-window
 * counters per client IP in Redis. The global limit applies to every proxied request, a route limit on top
 * of it when the method and the canonical path match exactly. Redis unavailable -> the request passes
 * without a limit (fail-open, no waiting: the client has no offline queue); one warning per change of state.
 */
@Injectable()
export class RateLimiter implements OnModuleInit, OnApplicationShutdown {
  private unavailable = false;
  // Set by register(), before the proxy routes exist.
  private fastify: FastifyInstance;
  private limiters?: Limiters;

  constructor(
    @Inject(RATE_LIMIT_REDIS) private readonly redis: RateLimitRedis,
    @InjectPinoLogger(RateLimiter.name) private readonly logger: PinoLogger,
  ) {
    // Without an "error" listener ioredis writes a non-JSON line to stderr on every reconnect attempt.
    this.redis.on('error', (error) => this.markUnavailable(error));
    this.redis.on('ready', () => this.markAvailable());
  }

  onModuleInit(): void {
    // Errors arrive as "error" events; ioredis keeps reconnecting on its own.
    this.redis.connect().catch(() => undefined);
  }

  onApplicationShutdown(): void {
    // The plugin does not close the client it gets.
    this.redis.disconnect();
  }

  /**
   * Registers @fastify/rate-limit: no automatic limit on routes (global: false, the proxy calls check() in
   * step 3), counters in redis-gateway through the store below, fail-open (skipOnError: a Redis error lets
   * the request pass). No x-ratelimit-* headers: limiters from createRateLimit() never set headers.
   */
  async register(fastify: FastifyInstance): Promise<void> {
    await fastify.register(fastifyRateLimit, { global: false, store: this.store(), skipOnError: true });
    this.fastify = fastify;
  }

  /**
   * Counts the request in the global limit, then in the route limit (path = canonical path without the
   * public prefix, null when the path is not canonical: only the global limit). Throws 429 with Retry-After.
   * When Redis did not answer the global check (fail-open), the route limit is skipped: a hanging Redis
   * delays a request once (commandTimeout), not once per limit.
   */
  async check(request: FastifyRequest, path: string | null, config: RateLimitConfig): Promise<void> {
    const limiters = this.limitersFor(config);
    const answered = await this.enforce(limiters.global, request);
    const route = path === null ? undefined : limiters.routes.find(({ limit }) => limit.method === request.method && limit.path === path);
    if (route && answered) {
      await this.enforce(route.limiter, request);
    }
  }

  /** Throws 429 over the limit; false = Redis did not answer (the request passes without this limit). */
  private async enforce(limiter: Limiter, request: FastifyRequest): Promise<boolean> {
    const result = await limiter(request);
    // isAllowed is true only for an allowList, which is not used.
    if (result.isAllowed) {
      return true;
    }
    if (result.isExceeded) {
      throw new AppException(
        429,
        'TOO_MANY_REQUESTS',
        ERROR_MESSAGES.tooManyRequests,
        retryAfterSeconds(result.ttl, result.timeWindow / 1000),
      );
    }
    // A store error skipped by skipOnError leaves ttl 0 (applyRateLimit in index.js of @fastify/rate-limit
    // 11.x, covered by the tests). A counted request gets the window or the PTTL of its counter, which is
    // 0 only in the last millisecond of the window: then this request skips the route limit once.
    return result.ttl > 0;
  }

  /**
   * Limiters for the limits from KV. The configuration is read after startup and stays the same until a
   * restart, so they are created on first use and again only for a different configuration object.
   */
  private limitersFor(config: RateLimitConfig): Limiters {
    if (this.limiters?.config !== config) {
      const create = (name: string, limit: Limit): Limiter =>
        this.fastify.createRateLimit({
          keyGenerator: (request) => `${name}:${request.ip}`,
          max: limit.max,
          timeWindow: limit.timeWindowSeconds * 1000,
        });
      this.limiters = {
        config,
        global: create('global', config.global),
        routes: config.routes.map((limit) => ({ limit, limiter: create(`${limit.method}:${limit.path}`, limit) })),
      };
    }
    return this.limiters;
  }

  /**
   * Store for the plugin: the Redis store of the library (its fixed-window script) on our client, with the
   * prefix KEY_PREFIX, so a key is exactly the prefix + keyGenerator. Not the plugin's "redis" option:
   * createRateLimit(options) gets store.child({ routeInfo: {} }), and the child of the built-in store adds
   * routeInfo.method and routeInfo.url to the prefix ("rate-limit:undefinedundefined-global:..."). Here
   * child() returns the same store. Every answer and error of Redis passes by here (warning and info).
   */
  private store(): FastifyRateLimitStoreCtor {
    const redisStore = new RedisStore(false, false, this.redis, KEY_PREFIX);
    const track = (error: Error | null): void => (error ? this.markUnavailable(error) : this.markAvailable());
    return class implements FastifyRateLimitStore {
      incr(...[key, callback, timeWindow, max]: Parameters<FastifyRateLimitStore['incr']>): void {
        redisStore.incr(
          key,
          (error, result) => {
            track(error);
            callback(error, result);
          },
          timeWindow,
          max,
        );
      }

      child(): FastifyRateLimitStore {
        return this;
      }
    };
  }

  private markUnavailable(error: unknown): void {
    if (this.unavailable) {
      return;
    }
    this.unavailable = true;
    const reason = error instanceof Error ? ((error as { code?: string }).code ?? error.message) : String(error);
    this.logger.warn({ reason }, 'Redis for rate limits is unavailable, requests pass without a limit');
  }

  private markAvailable(): void {
    if (!this.unavailable) {
      return;
    }
    this.unavailable = false;
    this.logger.info('Redis for rate limits is available again, limits apply');
  }
}
