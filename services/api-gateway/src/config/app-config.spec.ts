import { buildAppConfig, parseTrustedProxies } from './app-config';

describe('static configuration (environment variables)', () => {
  it('uses defaults for optional variables', () => {
    const config = buildAppConfig({ REDIS_PASSWORD: 'test-redis' });
    expect(config.port).toBe(8080);
    expect(config.instanceId).toMatch(/^api-gateway-/);
    expect(config.consul).toEqual({ host: '127.0.0.1', port: 8500, serviceAddress: '' });
    expect(config.redis).toEqual({ host: '127.0.0.1', port: 6379, password: 'test-redis' });
    expect(config.trustedProxies).toEqual([]);
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
    });
    expect(config.port).toBe(18080);
    expect(config.consul).toEqual({ host: 'consul', port: 8501, serviceAddress: 'host.docker.internal' });
    expect(config.redis).toEqual({ host: 'redis-gateway', port: 6380, password: 'test-redis' });
    expect(config.overrides).toEqual({ logLevel: 'debug', jwtIssuer: 'iss', jwtAudience: 'aud' });
    expect(config.trustedProxies).toEqual([{ kind: 'hostname', name: 'frontend' }]);
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
