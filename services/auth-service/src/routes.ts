/**
 * Every HTTP path of Auth Service in one place (stage 2, Z8): own endpoints, the refresh cookie
 * path, the called User Service endpoint and the Consul HTTP API. Code and tests use these
 * constants; no other file in src/ spells out a path.
 */

// Own endpoints in the parts that Nest decorators take: @Controller(ROUTES.auth.base) + @Post(ROUTES.auth.login).
export const ROUTES = {
  auth: { base: 'auth', register: 'register', login: 'login', refresh: 'refresh', logout: 'logout' },
  health: { base: 'health', live: 'live', ready: 'ready' },
  jwks: { base: '.well-known', document: 'jwks.json' },
  // Swagger UI and the OpenAPI document.
  docs: { ui: 'docs', openApi: 'openapi.json' },
} as const;

function fullPath(...parts: string[]): string {
  return `/${parts.join('/')}`;
}

// The same endpoints as full paths (Consul health check, tests).
export const PATHS = {
  register: fullPath(ROUTES.auth.base, ROUTES.auth.register),
  login: fullPath(ROUTES.auth.base, ROUTES.auth.login),
  refresh: fullPath(ROUTES.auth.base, ROUTES.auth.refresh),
  logout: fullPath(ROUTES.auth.base, ROUTES.auth.logout),
  healthLive: fullPath(ROUTES.health.base, ROUTES.health.live),
  healthReady: fullPath(ROUTES.health.base, ROUTES.health.ready),
  jwks: fullPath(ROUTES.jwks.base, ROUTES.jwks.document),
};

// The browser reaches Auth through the Gateway under /api/v1 (the Gateway strips the prefix, stage 3).
export const GATEWAY_PREFIX = '/api/v1';

// Path of the refresh_token cookie (decision 17): the browser sends it only to /api/v1/auth/*.
export const REFRESH_COOKIE_PATH = `${GATEWAY_PREFIX}${fullPath(ROUTES.auth.base)}`;

// User Service: profile of a new account (contract 3.2).
export const USER_SERVICE_USERS_PATH = '/users';

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

/** Raw value of a KV key. The key keeps its slashes, e.g. config/auth-service/data. */
export function consulKvRawPath(key: string): string {
  return `/v1/kv/${key}?raw`;
}
