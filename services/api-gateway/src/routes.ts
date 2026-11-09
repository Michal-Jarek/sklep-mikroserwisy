/**
 * Every HTTP path of the Gateway in one place (stage 2, Z8): own endpoints, the prefix of the
 * proxied API, the JWKS endpoint of Auth Service and the Consul HTTP API. Code and tests use
 * these constants; no other file in src/ spells out a path.
 */

// Own endpoints in the parts that Nest decorators take: @Controller(ROUTES.health.base) + @Get(ROUTES.health.live).
export const ROUTES = {
  health: { base: 'health', live: 'live', ready: 'ready' },
} as const;

function fullPath(...parts: string[]): string {
  return `/${parts.join('/')}`;
}

// The same endpoints as full paths (Consul health check, tests).
export const PATHS = {
  healthLive: fullPath(ROUTES.health.base, ROUTES.health.live),
  healthReady: fullPath(ROUTES.health.base, ROUTES.health.ready),
};

// Public API prefix: /api/v1/<resource>/... is proxied to the service without the prefix.
export const GATEWAY_PREFIX = '/api/v1';

// Public keys of Auth Service for access token verification (called on an auth-service instance from Consul).
export const AUTH_JWKS_PATH = '/.well-known/jwks.json';

// Consul HTTP API of the local agent.
export const CONSUL_REGISTER_PATH = '/v1/agent/service/register';

export function consulServicePath(serviceId: string): string {
  return `/v1/agent/service/${encodeURIComponent(serviceId)}`;
}

export function consulDeregisterPath(serviceId: string): string {
  return `/v1/agent/service/deregister/${encodeURIComponent(serviceId)}`;
}

/** Healthy instances of a service (checks passing). */
export function consulHealthyInstancesPath(serviceName: string): string {
  return `/v1/health/service/${encodeURIComponent(serviceName)}?passing`;
}

/** Raw value of a KV key. The key keeps its slashes, e.g. config/api-gateway/data. */
export function consulKvRawPath(key: string): string {
  return `/v1/kv/${key}?raw`;
}
