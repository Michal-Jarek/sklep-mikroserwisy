import { parse } from 'yaml';
import { type AppConfig, isLogLevel, LOG_LEVELS, type LogLevel } from './app-config';

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const ACCESS_LEVELS = ['public', 'authenticated', 'ADMIN', 'blocked'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export interface AccessRule {
  methods: readonly HttpMethod[] | 'ANY';
  // Segments of the path without /api/v1, e.g. ['users', '*']; "*" = one segment, "**" (last only) = zero or more.
  pattern: readonly string[];
  access: AccessLevel;
}

export interface RouteLimit {
  method: HttpMethod;
  // Exact path without /api/v1, e.g. /auth/login.
  path: string;
  max: number;
  timeWindowSeconds: number;
}

/** Configuration of the Gateway from Consul KV (config/api-gateway/data) merged with env overrides. */
export interface GatewayConfig {
  logLevel: LogLevel;
  jwt: { issuer: string; audience: string };
  proxy: { timeoutSeconds: number };
  // First path segment after /api/v1 -> service name in Consul.
  routes: ReadonlyMap<string, string>;
  access: readonly AccessRule[];
  rateLimit: {
    global: { max: number; timeWindowSeconds: number };
    routes: readonly RouteLimit[];
  };
  cors: { allowedOrigins: readonly string[] };
}

// Defaults only for scalar fields; routes, access rules and route limits come only from KV.
export const SCALAR_DEFAULTS = {
  logLevel: 'info',
  jwt: { issuer: 'sklep-auth', audience: 'sklep-api' },
  proxy: { timeoutSeconds: 10 },
  rateLimit: { global: { max: 300, timeWindowSeconds: 60 } },
  cors: { allowedOrigins: [] as string[] },
} as const;

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
// One literal path segment: RFC 3986 unreserved characters.
const LITERAL_SEGMENT = /^[A-Za-z0-9._~-]+$/;

/** The KV document breaks a rule; the message names the field (no document content). */
export class ConfigValidationError extends Error {
  constructor(field: string, problem: string) {
    super(`${field} ${problem}`);
    this.name = 'ConfigValidationError';
  }
}

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mapping(value: unknown, field: string): Mapping {
  if (!isMapping(value)) {
    throw new ConfigValidationError(field, 'must be a mapping');
  }
  return value;
}

function optionalMapping(value: unknown, field: string): Mapping {
  return value === undefined ? {} : mapping(value, field);
}

function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ConfigValidationError(field, 'must be a list');
  }
  return value;
}

function requiredKey(doc: Mapping, key: string, field: string): unknown {
  if (!(key in doc) || doc[key] === undefined || doc[key] === null) {
    throw new ConfigValidationError(field, 'is required');
  }
  return doc[key];
}

function optionalString(value: unknown, field: string, fallback: string): string {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigValidationError(field, 'must be a non-empty string');
  }
  return value;
}

function positiveNumber(value: unknown, field: string, integer: boolean): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new ConfigValidationError(field, integer ? 'must be a positive integer' : 'must be a positive number');
  }
  return value;
}

function optionalPositive(value: unknown, field: string, integer: boolean, fallback: number): number {
  return value === undefined ? fallback : positiveNumber(value, field, integer);
}

function name(value: unknown, field: string): string {
  if (typeof value !== 'string' || !NAME_PATTERN.test(value)) {
    throw new ConfigValidationError(field, `must match ${NAME_PATTERN.source}`);
  }
  return value;
}

function httpMethod(value: unknown, field: string): HttpMethod {
  if (typeof value !== 'string' || !(HTTP_METHODS as readonly string[]).includes(value)) {
    throw new ConfigValidationError(field, `must be one of ${HTTP_METHODS.join(', ')}`);
  }
  return value as HttpMethod;
}

function pathSegments(value: unknown, field: string): string[] {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    throw new ConfigValidationError(field, 'must be a string starting with /');
  }
  return value.slice(1).split('/');
}

function parseRoutes(value: unknown): Map<string, string> {
  const routes = new Map<string, string>();
  for (const [resource, service] of Object.entries(mapping(value, 'routes'))) {
    name(resource, `routes key "${resource}"`);
    routes.set(resource, name(service, `routes.${resource}`));
  }
  return routes;
}

function parseMethods(value: unknown, field: string): AccessRule['methods'] {
  const items = list(value, field);
  if (items.length === 0) {
    throw new ConfigValidationError(field, 'must not be empty');
  }
  // Every item is checked, also next to ANY (decision 4: no partly valid document).
  const methods = items.map((item, index) => {
    if (item !== 'ANY' && (typeof item !== 'string' || !(HTTP_METHODS as readonly string[]).includes(item))) {
      throw new ConfigValidationError(`${field}[${index}]`, `must be one of ${HTTP_METHODS.join(', ')}, ANY`);
    }
    return item as HttpMethod | 'ANY';
  });
  return methods.includes('ANY') ? 'ANY' : (methods as HttpMethod[]);
}

function parsePattern(value: unknown, field: string): string[] {
  const segments = pathSegments(value, field);
  segments.forEach((segment, index) => {
    if (segment === '**') {
      if (index !== segments.length - 1) {
        throw new ConfigValidationError(field, 'may use ** only as the last segment');
      }
    } else if (segment !== '*' && !LITERAL_SEGMENT.test(segment)) {
      throw new ConfigValidationError(field, `has an invalid segment (allowed: *, **, ${LITERAL_SEGMENT.source})`);
    }
  });
  return segments;
}

function parseAccess(value: unknown): AccessRule[] {
  return list(value, 'access').map((item, index) => {
    const field = `access[${index}]`;
    const rule = mapping(item, field);
    const access = requiredKey(rule, 'access', `${field}.access`);
    if (typeof access !== 'string' || !(ACCESS_LEVELS as readonly string[]).includes(access)) {
      throw new ConfigValidationError(`${field}.access`, `must be one of ${ACCESS_LEVELS.join(', ')}`);
    }
    return {
      methods: parseMethods(requiredKey(rule, 'methods', `${field}.methods`), `${field}.methods`),
      pattern: parsePattern(requiredKey(rule, 'path', `${field}.path`), `${field}.path`),
      access: access as AccessLevel,
    };
  });
}

function parseRouteLimits(value: unknown): RouteLimit[] {
  return list(value, 'rateLimit.routes').map((item, index) => {
    const field = `rateLimit.routes[${index}]`;
    const limit = mapping(item, field);
    const path = requiredKey(limit, 'path', `${field}.path`);
    if (!pathSegments(path, `${field}.path`).every((segment) => LITERAL_SEGMENT.test(segment))) {
      throw new ConfigValidationError(`${field}.path`, `must be an exact path with segments matching ${LITERAL_SEGMENT.source}`);
    }
    return {
      method: httpMethod(requiredKey(limit, 'method', `${field}.method`), `${field}.method`),
      path: path as string,
      max: positiveNumber(requiredKey(limit, 'max', `${field}.max`), `${field}.max`, true),
      timeWindowSeconds: positiveNumber(
        requiredKey(limit, 'timeWindowSeconds', `${field}.timeWindowSeconds`),
        `${field}.timeWindowSeconds`,
        true,
      ),
    };
  });
}

function parseOrigins(value: unknown): string[] {
  if (value === undefined) {
    return [...SCALAR_DEFAULTS.cors.allowedOrigins];
  }
  return list(value, 'cors.allowedOrigins').map((origin, index) => {
    if (typeof origin !== 'string' || origin === '') {
      throw new ConfigValidationError(`cors.allowedOrigins[${index}]`, 'must be a non-empty string');
    }
    return origin;
  });
}

/**
 * Validates the parsed KV document (decision 4). Any broken rule rejects the whole document with
 * ConfigValidationError; unknown keys are ignored. routes, access and rateLimit.routes are required
 * (empty allowed), so a typo in a key name cannot silently drop rules. Scalar fields are optional.
 */
export function validateGatewayConfig(doc: unknown, overrides: AppConfig['overrides'] = {}): GatewayConfig {
  const root = mapping(doc, 'document');
  if (root.logLevel !== undefined && !isLogLevel(root.logLevel)) {
    throw new ConfigValidationError('logLevel', `must be one of ${LOG_LEVELS.join(', ')}`);
  }
  const jwt = optionalMapping(root.jwt, 'jwt');
  const proxy = optionalMapping(root.proxy, 'proxy');
  const rateLimit = mapping(requiredKey(root, 'rateLimit', 'rateLimit'), 'rateLimit');
  const global = optionalMapping(rateLimit.global, 'rateLimit.global');
  const cors = optionalMapping(root.cors, 'cors');
  const defaults = SCALAR_DEFAULTS;

  const config: GatewayConfig = {
    logLevel: root.logLevel ?? defaults.logLevel,
    jwt: {
      issuer: optionalString(jwt.issuer, 'jwt.issuer', defaults.jwt.issuer),
      audience: optionalString(jwt.audience, 'jwt.audience', defaults.jwt.audience),
    },
    proxy: {
      timeoutSeconds: optionalPositive(proxy.timeoutSeconds, 'proxy.timeoutSeconds', false, defaults.proxy.timeoutSeconds),
    },
    routes: parseRoutes(requiredKey(root, 'routes', 'routes')),
    access: parseAccess(requiredKey(root, 'access', 'access')),
    rateLimit: {
      global: {
        max: optionalPositive(global.max, 'rateLimit.global.max', true, defaults.rateLimit.global.max),
        timeWindowSeconds: optionalPositive(
          global.timeWindowSeconds,
          'rateLimit.global.timeWindowSeconds',
          true,
          defaults.rateLimit.global.timeWindowSeconds,
        ),
      },
      routes: parseRouteLimits(requiredKey(rateLimit, 'routes', 'rateLimit.routes')),
    },
    cors: { allowedOrigins: parseOrigins(cors.allowedOrigins) },
  };
  // Environment variables take precedence over KV.
  return {
    ...config,
    logLevel: overrides.logLevel ?? config.logLevel,
    jwt: {
      issuer: overrides.jwtIssuer ?? config.jwt.issuer,
      audience: overrides.jwtAudience ?? config.jwt.audience,
    },
  };
}

/**
 * Parses the YAML text from KV. Throws YAMLParseError on invalid YAML (message without the source
 * excerpt, so no document content reaches the logs) or ConfigValidationError on a broken rule.
 */
export function parseGatewayConfig(text: string, overrides: AppConfig['overrides'] = {}): GatewayConfig {
  // logLevel 'error': YAML warnings would go to the console as plain text (logs are JSON only).
  return validateGatewayConfig(parse(text, { prettyErrors: false, logLevel: 'error' }), overrides);
}
