import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { RateLimiter } from './rate-limiter.service';

/**
 * Registers @fastify/rate-limit with the store in redis-gateway (RateLimiter.register). The limits are
 * applied by the proxy in step 3, not by hooks. Call after setupApp() and before setupProxy().
 */
export async function setupRateLimit(app: NestFastifyApplication): Promise<void> {
  await app.get(RateLimiter).register(app.getHttpAdapter().getInstance());
}
