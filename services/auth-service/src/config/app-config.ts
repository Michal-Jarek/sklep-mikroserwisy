import { hostname } from 'node:os';
import { parse } from 'yaml';
import {
  isValidEmail,
  isValidPasswordLength,
  normalizeEmail,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_BYTES,
} from '../auth/credentials';

export const SERVICE_NAME = 'auth-service';

// Injection token for the loaded configuration: @Inject(APP_CONFIG) config: AppConfig.
export const APP_CONFIG = Symbol('APP_CONFIG');

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface AppConfig {
  port: number;
  // ID in Consul and value of the X-Instance-Id header.
  instanceId: string;
  logLevel: LogLevel;
  consul: {
    enabled: boolean;
    host: string;
    port: number;
    // Address registered in Consul; empty means "first non-loopback IPv4 of the container".
    serviceAddress: string;
  };
  db: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
  };
  // RabbitMQ connection of the outbox relay (account auth-service, vhost /).
  rabbitmq: {
    host: string;
    port: number;
    user: string;
    password: string;
  };
  jwt: {
    issuer: string;
    audience: string;
  };
  // PKCS#8 PEM file with the RS256 signing key. Checked when the key is loaded at startup.
  jwtPrivateKeyFile: string;
  // First admin account, created at startup. null when ADMIN_EMAIL and ADMIN_PASSWORD are both empty.
  admin: { email: string; password: string } | null;
  // false: registration does not call User Service (in Compose until stage 5).
  userServiceEnabled: boolean;
}

// Keys stored in Consul KV (config/auth-service/data). Defaults are the same as deploy/consul/config/auth-service.yaml.
export interface KvConfig {
  logLevel: LogLevel;
  jwt: { issuer: string; audience: string };
}

export const KV_DEFAULTS: KvConfig = {
  logLevel: 'info',
  jwt: { issuer: 'sklep-auth', audience: 'sklep-api' },
};

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

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Parses the YAML document from Consul KV. Unknown keys are ignored, a key with a wrong type
 * keeps its default. Throws when the text is not a YAML mapping.
 */
export function parseKvConfig(text: string): KvConfig {
  const doc: unknown = parse(text);
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('KV value is not a YAML mapping');
  }
  const data = doc as { logLevel?: unknown; jwt?: { issuer?: unknown; audience?: unknown } | null };
  const jwt = data.jwt ?? {};
  return {
    logLevel: isLogLevel(data.logLevel) ? data.logLevel : KV_DEFAULTS.logLevel,
    jwt: {
      issuer: nonEmptyString(jwt.issuer) ? jwt.issuer : KV_DEFAULTS.jwt.issuer,
      audience: nonEmptyString(jwt.audience) ? jwt.audience : KV_DEFAULTS.jwt.audience,
    },
  };
}

/**
 * ADMIN_EMAIL and ADMIN_PASSWORD: both empty means "no admin account" (e.g. a local run from VS Code).
 * Only one of them, an invalid email or a password outside 10-72 bytes stops the startup.
 * Error messages never contain the values.
 */
function adminAccount(env: Env): AppConfig['admin'] {
  const email = normalizeEmail(env.ADMIN_EMAIL ?? '');
  const password = env.ADMIN_PASSWORD ?? '';
  if (!email && !password) {
    return null;
  }
  if (!email || !password) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be set together (or both left empty)');
  }
  if (!isValidEmail(email)) {
    throw new Error('Invalid ADMIN_EMAIL');
  }
  if (!isValidPasswordLength(password)) {
    throw new Error(`ADMIN_PASSWORD must be ${PASSWORD_MIN_BYTES}-${PASSWORD_MAX_BYTES} bytes long (UTF-8)`);
  }
  return { email, password };
}

/**
 * Builds the configuration: environment variables > Consul KV > defaults.
 * `kv` is the already loaded KV config (or the defaults when Consul is disabled or unavailable).
 */
export function buildConfig(env: Env, kv: KvConfig): AppConfig {
  const logLevel = env.LOG_LEVEL;
  if (logLevel !== undefined && logLevel !== '' && !isLogLevel(logLevel)) {
    throw new Error(`Invalid LOG_LEVEL, expected one of: ${LOG_LEVELS.join(', ')}`);
  }
  return {
    port: portNumber(env, 'PORT', 8081),
    instanceId: `${SERVICE_NAME}-${hostname()}`,
    logLevel: logLevel || kv.logLevel,
    consul: {
      enabled: env.CONSUL_ENABLED !== 'false',
      host: env.CONSUL_HOST || '127.0.0.1',
      port: portNumber(env, 'CONSUL_PORT', 8500),
      serviceAddress: env.SERVICE_ADDRESS ?? '',
    },
    db: {
      host: required(env, 'DB_HOST'),
      port: portNumber(env, 'DB_PORT', 5432),
      name: required(env, 'DB_NAME'),
      user: required(env, 'DB_USER'),
      password: required(env, 'DB_PASSWORD'),
    },
    rabbitmq: {
      host: required(env, 'RABBITMQ_HOST'),
      port: portNumber(env, 'RABBITMQ_PORT', 5672),
      user: required(env, 'RABBITMQ_USER'),
      password: required(env, 'RABBITMQ_PASSWORD'),
    },
    jwt: {
      issuer: env.JWT_ISSUER || kv.jwt.issuer,
      audience: env.JWT_AUDIENCE || kv.jwt.audience,
    },
    jwtPrivateKeyFile: env.JWT_PRIVATE_KEY_FILE ?? '',
    admin: adminAccount(env),
    userServiceEnabled: env.USER_SERVICE_ENABLED !== 'false',
  };
}
