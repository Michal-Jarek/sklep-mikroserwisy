import { hostname } from 'node:os';

export const SERVICE_NAME = 'api-gateway';

// Injection token for the static configuration: @Inject(APP_CONFIG) config: AppConfig.
export const APP_CONFIG = Symbol('APP_CONFIG');

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

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

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/** Reads the environment variables. Throws (startup error) with the variable name, never with its value. */
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
    overrides: {
      logLevel: logLevel ? (logLevel as LogLevel) : undefined,
      jwtIssuer: env.JWT_ISSUER || undefined,
      jwtAudience: env.JWT_AUDIENCE || undefined,
    },
  };
}
