import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppException } from './app-exception';

/**
 * Cookies (request.cookies, reply.setCookie) and the rate limit plugin. Must run before listen():
 * the rate limit attaches to routes when Nest registers them. The plugin is not global; a route
 * opts in with @RouteConfig({ rateLimit: { max, timeWindow } }) and is limited per request.ip
 * (with trustProxy, see fastify-adapter.ts), in the memory of this instance.
 */
export async function registerFastifyPlugins(app: NestFastifyApplication): Promise<void> {
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, {
    global: false,
    // Thrown from the plugin's onRequest hook and sent by the global filter in the team format, with Retry-After.
    errorResponseBuilder: (_request, context) =>
      new AppException(
        429,
        'TOO_MANY_REQUESTS',
        'Too many login attempts from this address, try again later',
        Math.max(1, Math.ceil(context.ttl / 1000)),
      ),
  });
}
