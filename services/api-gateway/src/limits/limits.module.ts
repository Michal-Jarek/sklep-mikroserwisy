import { Module } from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { RATE_LIMIT_REDIS, RateLimiter, type RateLimitRedis } from './rate-limiter.service';

// Connection to redis-gateway within 2 s; a command waits at most 2 s, and never while disconnected.
export const REDIS_TIMEOUT_MS = 2000;

export function createRedisClient(config: AppConfig['redis']): RateLimitRedis {
  return new Redis({
    host: config.host,
    port: config.port,
    password: config.password,
    // Connected in RateLimiter.onModuleInit, after its "error" listener is attached.
    lazyConnect: true,
    // Fail-open without waiting (decision 20): a command fails at once while Redis is unavailable.
    enableOfflineQueue: false,
    connectTimeout: REDIS_TIMEOUT_MS,
    commandTimeout: REDIS_TIMEOUT_MS,
    // Reconnecting keeps the default strategy: the limits come back when Redis does.
  });
}

/** Rate limits in Redis shared by all Gateway instances (decision 20); the plugin is registered by setupRateLimit(). */
@Module({
  providers: [
    RateLimiter,
    { provide: RATE_LIMIT_REDIS, inject: [APP_CONFIG], useFactory: (config: AppConfig) => createRedisClient(config.redis) },
  ],
  exports: [RateLimiter],
})
export class LimitsModule {}
