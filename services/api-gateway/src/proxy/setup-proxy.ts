import fastifyReplyFrom from '@fastify/reply-from';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyError, FastifyReply, FastifyRequest, HTTPMethods } from 'fastify';
import { METHODS } from 'node:http';
import { GATEWAY_PREFIX } from '../routes';
import { ProxyService } from './proxy.service';

// Connection to a service instance within 2 s (architecture rule); the response limit is set per request.
export const CONNECT_TIMEOUT_MS = 2000;

// Every method Node can parse (CONNECT never reaches routes): unknown ones get 405 in the team format.
export const PROXY_ROUTE_METHODS = METHODS.filter((method) => method !== 'CONNECT');

/**
 * Registers @fastify/reply-from and the proxy routes: the public prefix alone and everything under it,
 * for every method. Fastify routes rather than a Nest controller: the handler reads the raw URL and
 * streams the service response. Call after setupApp() and before listen().
 */
export async function setupProxy(app: NestFastifyApplication): Promise<void> {
  // No base URL: every request names the instance chosen for it (decision 10).
  await app.register(fastifyReplyFrom, { undici: { connectTimeout: CONNECT_TIMEOUT_MS }, disableRequestLogging: true });

  const fastify = app.getHttpAdapter().getInstance();
  // The Fastify router knows only some methods; without them e.g. PROPFIND would end as 404 instead of 405.
  for (const method of PROXY_ROUTE_METHODS) {
    if (!fastify.supportedMethods.includes(method)) {
      fastify.addHttpMethod(method, { hasBody: true });
    }
  }

  const proxy = app.get(ProxyService);
  const route = {
    method: PROXY_ROUTE_METHODS as HTTPMethods[],
    handler: (request: FastifyRequest, reply: FastifyReply): void => proxy.handle(request, reply),
    // Registered before Nest sets its error handler, so these routes would get the default Fastify format.
    errorHandler: (error: FastifyError, request: FastifyRequest, reply: FastifyReply): void => proxy.handleError(error, request, reply),
  };
  fastify.route({ ...route, url: GATEWAY_PREFIX });
  fastify.route({ ...route, url: `${GATEWAY_PREFIX}/*` });
}
