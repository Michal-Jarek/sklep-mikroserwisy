import { hostname } from 'node:os';
import { buildAppConfig, parseTrustedProxies } from './app-config';

describe('static configuration (environment variables)', () => {
  it('uses defaults for optional variables', () => {
    const config = buildAppConfig({ REDIS_PASSWORD: 'test-redis' });
    expect(config.port).toBe(8080);
    expect(config.instanceId).toMatch(/^api-gateway-/);
    expect(config.consul).toEqual({ host: '127.0.0.1', port: 8500, serviceAddress: '' });
    expect(config.redis).toEqual({ host: '127.0.0.1', port: 6379, password: 'test-redis' });
    expect(config.trustedProxies).toEqual([]);
    expect(config.authJwksOrigin).toBeUndefined();
    expect(config.overrides).toEqual({ logLevel: undefined, jwtIssuer: undefined, jwtAudience: undefined });
  });

  it('reads all variables', () => {
    const config = buildAppConfig({
      PORT: '18080',
      CONSUL_HOST: 'consul',
      CONSUL_PORT: '8501',
      SERVICE_ADDRESS: 'host.docker.internal',
      REDIS_HOST: 'redis-gateway',
      REDIS_PORT: '6380',
      REDIS_PASSWORD: 'test-redis',
      LOG_LEVEL: 'debug',
      JWT_ISSUER: 'iss',
      JWT_AUDIENCE: 'aud',
      TRUSTED_PROXIES: 'frontend',
      AUTH_JWKS_ORIGIN: 'http://auth-service.shop.svc.cluster.local:8081',
    });
    expect(config.port).toBe(18080);
    expect(config.consul).toEqual({ host: 'consul', port: 8501, serviceAddress: 'host.docker.internal' });
    expect(config.redis).toEqual({ host: 'redis-gateway', port: 6380, password: 'test-redis' });
    expect(config.overrides).toEqual({ logLevel: 'debug', jwtIssuer: 'iss', jwtAudience: 'aud' });
    expect(config.trustedProxies).toEqual([{ kind: 'hostname', name: 'frontend' }]);
    expect(config.authJwksOrigin).toBe('http://auth-service.shop.svc.cluster.local:8081');
  });

  it('takes INSTANCE_ID when set, otherwise <service>-<hostname> (also for an empty value)', () => {
    expect(buildAppConfig({ REDIS_PASSWORD: 'x', INSTANCE_ID: 'api-gateway-7d9f-abc12' }).instanceId).toBe(
      'api-gateway-7d9f-abc12',
    );
    expect(buildAppConfig({ REDIS_PASSWORD: 'x' }).instanceId).toBe(`api-gateway-${hostname()}`);
    expect(buildAppConfig({ REDIS_PASSWORD: 'x', INSTANCE_ID: '' }).instanceId).toBe(`api-gateway-${hostname()}`);
    expect(buildAppConfig({ REDIS_PASSWORD: 'x', INSTANCE_ID: '  ' }).instanceId).toBe(`api-gateway-${hostname()}`);
  });

  it('trims INSTANCE_ID and stops the startup on characters outside [A-Za-z0-9._-] or over 128, without the value', () => {
    expect(buildAppConfig({ REDIS_PASSWORD: 'x', INSTANCE_ID: ' api-gateway_1.a ' }).instanceId).toBe('api-gateway_1.a');
    expect(buildAppConfig({ REDIS_PASSWORD: 'x', INSTANCE_ID: 'a'.repeat(128) }).instanceId).toBe('a'.repeat(128));
    for (const value of ['a'.repeat(129), 'gw\r\nX-Evil: 1', 'gw/1', 'gw 1', 'bramka-ż']) {
      expect(() => buildAppConfig({ REDIS_PASSWORD: 'x', INSTANCE_ID: value })).toThrow('Invalid INSTANCE_ID');
    }
    expect(() => buildAppConfig({ REDIS_PASSWORD: 'x', INSTANCE_ID: 'secret value' })).not.toThrow(/secret/);
  });

  it('fails without REDIS_PASSWORD, naming the variable', () => {
    expect(() => buildAppConfig({})).toThrow('Missing environment variable REDIS_PASSWORD');
    expect(() => buildAppConfig({ REDIS_PASSWORD: '' })).toThrow('REDIS_PASSWORD');
  });

  it('fails with an invalid port or log level, without the value', () => {
    expect(() => buildAppConfig({ REDIS_PASSWORD: 'x', PORT: 'abc' })).toThrow('Invalid port in PORT');
    expect(() => buildAppConfig({ REDIS_PASSWORD: 'x', REDIS_PORT: '70000' })).toThrow('REDIS_PORT');
    expect(() => buildAppConfig({ REDIS_PASSWORD: 'x', LOG_LEVEL: 'loud' })).toThrow('Invalid LOG_LEVEL');
    expect(() => buildAppConfig({ REDIS_PASSWORD: 'x', LOG_LEVEL: 'loud' })).not.toThrow(/loud/);
  });

  describe('CONSUL_HTTP_TOKEN', () => {
    const token = (value: string | undefined) => buildAppConfig({ REDIS_PASSWORD: 'x', CONSUL_HTTP_TOKEN: value }).consul.token;

    it('empty or unset means no token (no X-Consul-Token header, Docker Compose)', () => {
      expect(token(undefined)).toBeUndefined();
      expect(token('')).toBeUndefined();
    });

    it('takes the value as it is (Kubernetes: UUID from Secret api-gateway-secret)', () => {
      expect(token('6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b')).toBe('6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b');
    });

    it.each(['   ', ' 6f1c2b3a-secret', '6f1c2b3a-secret\n', 'secret with space', 'sécret-ü'])(
      'stops the startup for %j, naming the variable without the value',
      (value) => {
        const invalid = new Error('Invalid CONSUL_HTTP_TOKEN, expected visible ASCII characters without whitespace');
        // An Error object compares the whole message, so no value can be appended to it.
        expect(() => token(value)).toThrow(invalid);
      },
    );
  });

  describe('AUTH_JWKS_ORIGIN', () => {
    const origin =(value: string | undefined) => buildAppConfig({ REDIS_PASSWORD: 'x', AUTH_JWKS_ORIGIN: value }).authJwksOrigin;

    it('empty or unset means undefined (keys from an instance in Consul)', () => {
      expect(origin(undefined)).toBeUndefined();
      expect(origin('')).toBeUndefined();
    });

    it.each([
      ['http://auth-service.shop.svc.cluster.local:8081', 'http://auth-service.shop.svc.cluster.local:8081'],
      ['https://auth.example.test', 'https://auth.example.test'],
      // One trailing slash is the same origin; it is dropped, so the JWKS path is appended without "//".
      ['http://auth-service:8081/', 'http://auth-service:8081'],
      ['HTTP://Auth-Service:8081', 'http://auth-service:8081'],
      ['http://10.43.0.10:8081', 'http://10.43.0.10:8081'],
      ['http://[fd00::10]:8081', 'http://[fd00::10]:8081'],
    ])('accepts %s as the origin %s', (value, expected) => {
      expect(origin(value)).toBe(expected);
    });

    it.each([
      'ftp://auth-service:8081',
      'auth-service:8081',
      'auth-service',
      '//auth-service:8081',
      'http://auth-service:8081/.well-known/jwks.json',
      'http://auth-service:8081/api',
      'http://auth-service:8081//',
      'http://auth-service:8081/.',
      'http://auth-service:8081?x=1',
      'http://auth-service:8081/?',
      'http://auth-service:8081#keys',
      'http://auth-service:8081/#',
      'http://user:secret-value@auth-service:8081',
      'http://user@auth-service:8081',
      'http:\\auth-service:8081',
      'http://auth-service:8081\\',
      'http://',
      'http://:8081',
      'http://auth-service:99999',
      'http://auth-service:port',
      'http://auth service:8081',
      ' http://auth-service:8081',
    ])('stops the startup for %j, naming the variable but not the value', (value) => {
      let message = '';
      try {
        origin(value);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe(
        'Invalid AUTH_JWKS_ORIGIN, expected http(s)://host[:port] without path, query, fragment or credentials',
      );
    });
  });

  describe('TRUSTED_PROXIES', () => {
    it('reads addresses, CIDR ranges (IPv4 and IPv6) and host names, separated by commas', () => {
      expect(parseTrustedProxies(' frontend , 172.18.0.5,fd00::5, 10.42.0.0/16,fd00:1::/64,traefik.kube-system.svc.cluster.local')).toEqual([
        { kind: 'hostname', name: 'frontend' },
        { kind: 'address', address: '172.18.0.5' },
        { kind: 'address', address: 'fd00::5' },
        { kind: 'subnet', address: '10.42.0.0', prefix: 16 },
        { kind: 'subnet', address: 'fd00:1::', prefix: 64 },
        { kind: 'hostname', name: 'traefik.kube-system.svc.cluster.local' },
      ]);
    });

    it('empty or unset means nobody is trusted; empty elements are skipped', () => {
      expect(parseTrustedProxies(undefined)).toEqual([]);
      expect(parseTrustedProxies('')).toEqual([]);
      expect(parseTrustedProxies(' , ')).toEqual([]);
      expect(parseTrustedProxies('frontend,')).toEqual([{ kind: 'hostname', name: 'frontend' }]);
      expect(buildAppConfig({ REDIS_PASSWORD: 'x', TRUSTED_PROXIES: '' }).trustedProxies).toEqual([]);
    });

    it('a malformed element stops the startup, naming the element', () => {
      for (const entry of ['front_end', 'a b', '1.2.3', '300.1.1.1', '10.0.0.0/33', 'fd00::/129', '10.0.0.0/', '/8', '10.0.0.0/8/8', 'frontend:8080', '*']) {
        expect(() => buildAppConfig({ REDIS_PASSWORD: 'x', TRUSTED_PROXIES: `frontend,${entry}` })).toThrow(
          `Invalid entry in TRUSTED_PROXIES: ${entry}`,
        );
      }
    });
  });
});
