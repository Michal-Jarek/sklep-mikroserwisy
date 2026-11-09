import fastifyCors, { type FastifyCorsOptions } from '@fastify/cors';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { IncomingHttpHeaders } from 'node:http';
import { HTTP_METHODS } from '../config/gateway-config';
import { GatewayConfigState } from '../config/gateway-config-state.service';

// Decision 21.
export const CORS_ALLOWED_HEADERS = ['Content-Type', 'Authorization', 'X-Request-Id'];
export const CORS_EXPOSED_HEADERS = ['X-Request-Id', 'X-Instance-Id', 'X-Gateway-Instance-Id', 'Retry-After'];
export const CORS_MAX_AGE_SECONDS = 600;

/**
 * CORS options of one request (decision 21). Only an Origin from cors.allowedOrigins gets CORS headers;
 * an empty list, another origin or no Origin -> { origin: false }: no CORS headers, and OPTIONS goes on
 * to the proxy route (405). OPTIONS is a preflight only with Access-Control-Request-Method.
 */
export function corsOptionsFor(
  headers: IncomingHttpHeaders,
  method: string,
  allowedOrigins: readonly string[],
): FastifyCorsOptions {
  const origin = headers.origin;
  const preflight = method !== 'OPTIONS' || headers['access-control-request-method'] !== undefined;
  if (origin === undefined || !allowedOrigins.includes(origin) || !preflight) {
    return { origin: false };
  }
  return {
    origin,
    credentials: true,
    methods: [...HTTP_METHODS],
    allowedHeaders: CORS_ALLOWED_HEADERS,
    exposedHeaders: CORS_EXPOSED_HEADERS,
    maxAge: CORS_MAX_AGE_SECONDS,
  };
}

/**
 * Registers @fastify/cors. The list of origins comes from KV, which is read after listen(), so the
 * options are resolved per request. A valid preflight is answered (204) in the onRequest hook of the
 * plugin, before the proxy route. Call after setupApp() and before setupProxy().
 */
export async function setupCors(app: NestFastifyApplication): Promise<void> {
  const configState = app.get(GatewayConfigState);
  await app.register(fastifyCors, {
    delegator: (request, callback) =>
      callback(null, corsOptionsFor(request.headers, request.method, configState.current()?.cors.allowedOrigins ?? [])),
  });
}
