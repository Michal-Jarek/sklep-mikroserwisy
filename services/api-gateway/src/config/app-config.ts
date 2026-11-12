import { isIP } from 'node:net';
import { hostname } from 'node:os';

export const SERVICE_NAME = 'api-gateway';

// Injection token for the static configuration: @Inject(APP_CONFIG) config: AppConfig.
export const APP_CONFIG = Symbol('APP_CONFIG');

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** One element of TRUSTED_PROXIES: an IPv4/IPv6 address, a CIDR range or a host name resolved by DNS. */
export type TrustedProxy =
  | { kind: 'address'; address: string }
  | { kind: 'subnet'; address: string; prefix: number }
  | { kind: 'hostname'; name: string };

/** Static configuration from environment variables, known before the Consul KV document is read. */
export interface AppConfig {
  port: number;
  // ID in Consul and value of the X-Gateway-Instance-Id header.
  instanceId: string;
  consul: {
    host: string;
    port: number;
    // Address registered in Consul; empty means "local address of the route to the Consul agent".
    serviceAddress: string;
  };
  redis: {
    host: string;
    port: number;
    password: string;
  };
  // Direct peers whose X-Forwarded-For gives the client address (empty = nobody, the connection address counts).
  trustedProxies: TrustedProxy[];
  // Optional overrides of the KV document (environment variables > KV > defaults).
  overrides: {
    logLevel?: LogLevel;
    jwtIssuer?: string;
    jwtAudience?: string;
  };
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
}

function portNumber(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid port in ${name}`);
  }
  return value;
}

// Host name characters of the guidelines (3.3); digits and dots only would be a malformed IPv4 address.
const HOSTNAME_PATTERN = /^[A-Za-z0-9.-]+$/;
const DIGITS_AND_DOTS = /^[0-9.]+$/;
const PREFIX_PATTERN = /^[0-9]{1,3}$/;

function parseTrustedProxy(entry: string): TrustedProxy {
  const slash = entry.indexOf('/');
  if (slash === -1) {
    if (isIP(entry) !== 0) {
      return { kind: 'address', address: entry };
    }
    if (HOSTNAME_PATTERN.test(entry) && !DIGITS_AND_DOTS.test(entry)) {
      return { kind: 'hostname', name: entry };
    }
  } else {
    const address = entry.slice(0, slash);
    const prefix = entry.slice(slash + 1);
    const family = isIP(address);
    if (family !== 0 && PREFIX_PATTERN.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128)) {
      return { kind: 'subnet', address, prefix: Number(prefix) };
    }
  }
  throw new Error(`Invalid entry in TRUSTED_PROXIES: ${entry}`);
}

/**
 * TRUSTED_PROXIES: comma-separated addresses, CIDR ranges and host names (guidelines 3.3). Empty or unset means
 * nobody is trusted; empty elements (e.g. a trailing comma) are skipped. A malformed element stops the startup.
 */
export function parseTrustedProxies(value: string | undefined): TrustedProxy[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map(parseTrustedProxy);
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Reads the environment variables. Throws (startup error) with the variable name, never with its value; only a
 * malformed TRUSTED_PROXIES element is named (addresses and host names are not secrets).
 */
export function buildAppConfig(env: Env): AppConfig {
  const logLevel = env.LOG_LEVEL;
  if (logLevel && !isLogLevel(logLevel)) {
    throw new Error(`Invalid LOG_LEVEL, expected one of: ${LOG_LEVELS.join(', ')}`);
  }
  return {
    port: portNumber(env, 'PORT', 8080),
    instanceId: `${SERVICE_NAME}-${hostname()}`,
    consul: {
      host: env.CONSUL_HOST || '127.0.0.1',
      port: portNumber(env, 'CONSUL_PORT', 8500),
      serviceAddress: env.SERVICE_ADDRESS ?? '',
    },
    redis: {
      host: env.REDIS_HOST || '127.0.0.1',
      port: portNumber(env, 'REDIS_PORT', 6379),
      password: required(env, 'REDIS_PASSWORD'),
    },
    trustedProxies: parseTrustedProxies(env.TRUSTED_PROXIES),
    overrides: {
      logLevel: logLevel ? (logLevel as LogLevel) : undefined,
      jwtIssuer: env.JWT_ISSUER || undefined,
      jwtAudience: env.JWT_AUDIENCE || undefined,
    },
  };
}
