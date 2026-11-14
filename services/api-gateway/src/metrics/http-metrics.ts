import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { GatewayConfig } from '../config/gateway-config';
import { GatewayConfigState } from '../config/gateway-config-state.service';
import { canonicalPath, findService } from '../proxy/canonical-path';
import { ROUTES } from '../routes';
import { GatewayMetrics, NO_SERVICE } from './gateway-metrics';

const HEALTH_PREFIX = `/${ROUTES.health.base}`;

/**
 * The service label (guidelines 3.1): the route target of the first segment of the canonical path under the public
 * prefix, the same lookup as the proxy (also for requests that ended before routing: 429, 401, 404 of a rule);
 * NO_SERVICE without a loaded configuration, for a non-canonical path, outside the prefix or without a route.
 */
export function serviceLabel(config: GatewayConfig | null, rawUrl: string): string {
  if (config === null) {
    return NO_SERVICE;
  }
  const target = canonicalPath(rawUrl);
  return (target && findService(config.routes, target.segments)) ?? NO_SERVICE;
}

/** Own health endpoints (/health and below) are not counted: probes would hide the traffic. */
export function isHealthPath(rawUrl: string): boolean {
  const path = rawUrl.split('?', 1)[0];
  return path === HEALTH_PREFIX || path.startsWith(`${HEALTH_PREFIX}/`);
}

/**
 * onResponse hook that counts every response of the Gateway, also its own errors, except the health endpoints.
 * Fastify skips onResponse for a request the client aborted, so such requests may be missing (guidelines 3.1).
 * Call after setupApp() and before setupProxy().
 */
export function setupMetrics(app: NestFastifyApplication): void {
  const metrics = app.get(GatewayMetrics);
  const configState = app.get(GatewayConfigState);
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onResponse', (request, reply, done) => {
      const rawUrl = request.raw.url ?? '';
      if (!isHealthPath(rawUrl)) {
        metrics.recordResponse(serviceLabel(configState.current(), rawUrl), request.method, reply.statusCode, reply.elapsedTime / 1000);
      }
      done();
    });
}
