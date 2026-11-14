import { hostname } from 'node:os';
import { jest } from '@jest/globals';
import { consulKvRawPath } from '../routes';
import { buildConfig, KV_DEFAULTS, parseKvConfig } from './app-config';
import { loadConfig } from './load-config';

const BASE_ENV = {
  DB_HOST: 'postgres',
  DB_NAME: 'auth_db',
  DB_USER: 'auth_service',
  DB_PASSWORD: 'test-password',
  RABBITMQ_HOST: 'rabbitmq',
  RABBITMQ_USER: 'auth-service',
  RABBITMQ_PASSWORD: 'test-rabbitmq-password',
  CONSUL_HOST: 'consul',
};

const KV_YAML = 'logLevel: debug\njwt:\n  issuer: kv-issuer\n  audience: kv-audience\n';

function mockFetch(response: Response | Error) {
  const spy = jest.spyOn(global, 'fetch');
  if (response instanceof Error) {
    spy.mockRejectedValue(response);
  } else {
    spy.mockResolvedValue(response);
  }
  return spy;
}

describe('configuration', () => {
  const logger = { warn: jest.fn() };

  afterEach(() => {
    jest.restoreAllMocks();
    logger.warn.mockReset();
  });

  it('uses KV values over defaults', async () => {
    const fetchSpy = mockFetch(new Response(KV_YAML));
    const config = await loadConfig(BASE_ENV, logger);
    expect(fetchSpy).toHaveBeenCalledWith(`http://consul:8500${consulKvRawPath('config/auth-service/data')}`, expect.anything());
    expect(config.logLevel).toBe('debug');
    expect(config.jwt).toEqual({ issuer: 'kv-issuer', audience: 'kv-audience' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('uses environment variables over KV', async () => {
    mockFetch(new Response(KV_YAML));
    const config = await loadConfig(
      { ...BASE_ENV, LOG_LEVEL: 'warn', JWT_ISSUER: 'env-issuer', JWT_AUDIENCE: 'env-audience' },
      logger,
    );
    expect(config.logLevel).toBe('warn');
    expect(config.jwt).toEqual({ issuer: 'env-issuer', audience: 'env-audience' });
  });

  it('falls back to defaults with one warning when Consul is not reachable', async () => {
    mockFetch(new TypeError('fetch failed'));
    const config = await loadConfig(BASE_ENV, logger);
    expect(config.logLevel).toBe(KV_DEFAULTS.logLevel);
    expect(config.jwt).toEqual(KV_DEFAULTS.jwt);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toContain('Consul is not reachable');
  });

  it('falls back to defaults with a warning when the YAML in KV is invalid', async () => {
    mockFetch(new Response('logLevel: [unclosed'));
    const config = await loadConfig(BASE_ENV, logger);
    expect(config.jwt).toEqual(KV_DEFAULTS.jwt);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toContain('Invalid YAML');
  });

  it('falls back to defaults with a warning when the KV key is missing', async () => {
    mockFetch(new Response('', { status: 404 }));
    const config = await loadConfig(BASE_ENV, logger);
    expect(config.jwt).toEqual(KV_DEFAULTS.jwt);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toEqual({
      status: 404,
      key: 'config/auth-service/data',
      reason: 'Consul KV responded with 404',
    });
  });

  it('reads KV with CONSUL_HTTP_TOKEN in X-Consul-Token; a 403 (ACL) is one warning without the token', async () => {
    const token = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';
    const fetchSpy = mockFetch(new Response('Permission denied', { status: 403 }));
    const config = await loadConfig({ ...BASE_ENV, CONSUL_HTTP_TOKEN: token }, logger);
    expect(fetchSpy.mock.calls[0][1]?.headers).toEqual({ 'X-Consul-Token': token });
    expect(config.jwt).toEqual(KV_DEFAULTS.jwt);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toEqual({
      status: 403,
      key: 'config/auth-service/data',
      reason: 'Consul KV responded with 403 (ACL: CONSUL_HTTP_TOKEN missing or without permission)',
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(token);
  });

  it('reads KV without X-Consul-Token when CONSUL_HTTP_TOKEN is empty (Docker Compose)', async () => {
    const fetchSpy = mockFetch(new Response(KV_YAML));
    await loadConfig({ ...BASE_ENV, CONSUL_HTTP_TOKEN: '' }, logger);
    expect(fetchSpy.mock.calls[0][1]?.headers).toBeUndefined();
  });

  it('does not call Consul when CONSUL_ENABLED=false', async () => {
    const fetchSpy = mockFetch(new Response(KV_YAML));
    const config = await loadConfig({ ...BASE_ENV, CONSUL_ENABLED: 'false' }, logger);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(config.consul.enabled).toBe(false);
    expect(config.jwt).toEqual(KV_DEFAULTS.jwt);
  });

  it('builds defaults for optional variables', () => {
    const config = buildConfig(BASE_ENV, KV_DEFAULTS);
    expect(config.port).toBe(8081);
    expect(config.db).toEqual({ host: 'postgres', port: 5432, name: 'auth_db', user: 'auth_service', password: 'test-password' });
    expect(config.consul).toEqual({ enabled: true, host: 'consul', port: 8500, serviceAddress: '' });
    expect(config.instanceId).toMatch(/^auth-service-/);
  });

  it('takes INSTANCE_ID when set, otherwise <service>-<hostname> (also for an empty value)', () => {
    expect(buildConfig({ ...BASE_ENV, INSTANCE_ID: 'auth-service-5c8b-xyz34' }, KV_DEFAULTS).instanceId).toBe(
      'auth-service-5c8b-xyz34',
    );
    expect(buildConfig(BASE_ENV, KV_DEFAULTS).instanceId).toBe(`auth-service-${hostname()}`);
    expect(buildConfig({ ...BASE_ENV, INSTANCE_ID: '' }, KV_DEFAULTS).instanceId).toBe(`auth-service-${hostname()}`);
    expect(buildConfig({ ...BASE_ENV, INSTANCE_ID: '  ' }, KV_DEFAULTS).instanceId).toBe(`auth-service-${hostname()}`);
  });

  it('trims INSTANCE_ID and stops the startup on characters outside [A-Za-z0-9._-] or over 128, without the value', () => {
    expect(buildConfig({ ...BASE_ENV, INSTANCE_ID: ' auth-service_1.a ' }, KV_DEFAULTS).instanceId).toBe('auth-service_1.a');
    expect(buildConfig({ ...BASE_ENV, INSTANCE_ID: 'a'.repeat(128) }, KV_DEFAULTS).instanceId).toBe('a'.repeat(128));
    for (const value of ['a'.repeat(129), 'auth\r\nX-Evil: 1', 'auth/1', 'auth 1', 'usługa']) {
      expect(() => buildConfig({ ...BASE_ENV, INSTANCE_ID: value }, KV_DEFAULTS)).toThrow('Invalid INSTANCE_ID');
    }
    expect(() => buildConfig({ ...BASE_ENV, INSTANCE_ID: 'secret value' }, KV_DEFAULTS)).not.toThrow(/secret/);
  });

  it('takes CONSUL_HTTP_TOKEN as it is; empty or unset means no token', () => {
    const token = (value: string | undefined) => buildConfig({ ...BASE_ENV, CONSUL_HTTP_TOKEN: value }, KV_DEFAULTS).consul.token;
    expect(token('6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b')).toBe('6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b');
    expect(token('')).toBeUndefined();
    expect(token(undefined)).toBeUndefined();
  });

  it.each(['   ', ' 6f1c2b3a-secret', '6f1c2b3a-secret\n', 'secret with space', 'sécret-ü'])(
    'stops the startup for CONSUL_HTTP_TOKEN %j, naming the variable without the value',
    (value) => {
      // An Error object compares the whole message, so no value can be appended to it.
      const invalid = new Error('Invalid CONSUL_HTTP_TOKEN, expected visible ASCII characters without whitespace');
      expect(() => buildConfig({ ...BASE_ENV, CONSUL_HTTP_TOKEN: value }, KV_DEFAULTS)).toThrow(invalid);
    },
  );

  it('fails without a required DB variable', () => {
    expect(() => buildConfig({ ...BASE_ENV, DB_PASSWORD: '' }, KV_DEFAULTS)).toThrow('DB_PASSWORD');
  });

  it('reads the RabbitMQ connection, port 5672 by default', () => {
    expect(buildConfig(BASE_ENV, KV_DEFAULTS).rabbitmq).toEqual({
      host: 'rabbitmq',
      port: 5672,
      user: 'auth-service',
      password: 'test-rabbitmq-password',
    });
    expect(buildConfig({ ...BASE_ENV, RABBITMQ_PORT: '15673' }, KV_DEFAULTS).rabbitmq.port).toBe(15673);
  });

  it.each(['RABBITMQ_HOST', 'RABBITMQ_USER', 'RABBITMQ_PASSWORD'])('fails without %s, without values in the message', (name) => {
    // An Error object compares the whole message, so no value can be appended to it.
    const missing = new Error(`Missing environment variable ${name}`);
    expect(() => buildConfig({ ...BASE_ENV, [name]: '' }, KV_DEFAULTS)).toThrow(missing);
    expect(() => buildConfig({ ...BASE_ENV, [name]: undefined }, KV_DEFAULTS)).toThrow(missing);
  });

  it('fails with an invalid port or log level', () => {
    expect(() => buildConfig({ ...BASE_ENV, RABBITMQ_PORT: '70000' }, KV_DEFAULTS)).toThrow('RABBITMQ_PORT');
    expect(() => buildConfig({ ...BASE_ENV, PORT: 'abc' }, KV_DEFAULTS)).toThrow('PORT');
    expect(() => buildConfig({ ...BASE_ENV, LOG_LEVEL: 'loud' }, KV_DEFAULTS)).toThrow('LOG_LEVEL');
  });

  it('keeps defaults for KV keys with a wrong type and ignores unknown keys', () => {
    expect(parseKvConfig('logLevel: loud\njwt:\n  issuer: 42\nother: x\n')).toEqual(KV_DEFAULTS);
  });

  it('rejects a KV document that is not a mapping', () => {
    expect(() => parseKvConfig('- a\n- b\n')).toThrow();
  });

  it('reads the key file path and turns on the User Service call by default', () => {
    const config = buildConfig({ ...BASE_ENV, JWT_PRIVATE_KEY_FILE: '/run/secrets/jwt-private.pem' }, KV_DEFAULTS);
    expect(config.jwtPrivateKeyFile).toBe('/run/secrets/jwt-private.pem');
    expect(config.userServiceEnabled).toBe(true);
    expect(buildConfig({ ...BASE_ENV, USER_SERVICE_ENABLED: 'false' }, KV_DEFAULTS).userServiceEnabled).toBe(false);
  });

  describe('first admin account (ADMIN_EMAIL, ADMIN_PASSWORD)', () => {
    const PASSWORD = 'admin-password-123';

    function buildWithAdmin(email: string | undefined, password: string | undefined) {
      return () => buildConfig({ ...BASE_ENV, ADMIN_EMAIL: email, ADMIN_PASSWORD: password }, KV_DEFAULTS);
    }

    it('is skipped when both variables are empty or not set', () => {
      expect(buildWithAdmin(undefined, undefined)().admin).toBeNull();
      expect(buildWithAdmin('', '')().admin).toBeNull();
      expect(buildWithAdmin('  ', '')().admin).toBeNull();
    });

    it('normalizes the email like the registration', () => {
      expect(buildWithAdmin(' Admin@Sklep.Local ', PASSWORD)().admin).toEqual({
        email: 'admin@sklep.local',
        password: PASSWORD,
      });
    });

    it('stops the startup when only one of the variables is set', () => {
      expect(buildWithAdmin('admin@sklep.local', '')).toThrow('ADMIN_EMAIL and ADMIN_PASSWORD must be set together');
      expect(buildWithAdmin(undefined, PASSWORD)).toThrow('ADMIN_EMAIL and ADMIN_PASSWORD must be set together');
    });

    it('stops the startup on an invalid email, without the value in the message', () => {
      expect(buildWithAdmin('not-an-email', PASSWORD)).toThrow('Invalid ADMIN_EMAIL');
      expect(buildWithAdmin('not-an-email', PASSWORD)).not.toThrow('not-an-email');
    });

    it('requires a password of 10-72 bytes, without the value in the message', () => {
      expect(buildWithAdmin('admin@sklep.local', 'a'.repeat(9))).toThrow('ADMIN_PASSWORD must be 10-72 bytes');
      expect(buildWithAdmin('admin@sklep.local', 'a'.repeat(73))).toThrow('ADMIN_PASSWORD must be 10-72 bytes');
      expect(buildWithAdmin('admin@sklep.local', 'a'.repeat(9))).not.toThrow('aaaaaaaaa');
      expect(buildWithAdmin('admin@sklep.local', 'a'.repeat(10))().admin?.password).toHaveLength(10);
      expect(buildWithAdmin('admin@sklep.local', 'a'.repeat(72))().admin?.password).toHaveLength(72);
    });
  });
});
