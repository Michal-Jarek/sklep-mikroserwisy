import { buildAppConfig } from './app-config';

describe('static configuration (environment variables)', () => {
  it('uses defaults for optional variables', () => {
    const config = buildAppConfig({ REDIS_PASSWORD: 'test-redis' });
    expect(config.port).toBe(8080);
    expect(config.instanceId).toMatch(/^api-gateway-/);
    expect(config.consul).toEqual({ host: '127.0.0.1', port: 8500, serviceAddress: '' });
    expect(config.redis).toEqual({ host: '127.0.0.1', port: 6379, password: 'test-redis' });
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
    });
    expect(config.port).toBe(18080);
    expect(config.consul).toEqual({ host: 'consul', port: 8501, serviceAddress: 'host.docker.internal' });
    expect(config.redis).toEqual({ host: 'redis-gateway', port: 6380, password: 'test-redis' });
    expect(config.overrides).toEqual({ logLevel: 'debug', jwtIssuer: 'iss', jwtAudience: 'aud' });
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
});
