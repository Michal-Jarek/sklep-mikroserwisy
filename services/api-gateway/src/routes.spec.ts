import {
  AUTH_JWKS_PATH,
  CONSUL_REGISTER_PATH,
  consulDeregisterPath,
  consulHealthyInstancesPath,
  consulKvRawPath,
  consulServicePath,
  GATEWAY_PREFIX,
  PATHS,
} from './routes';

// The other tests use the constants; this one pins the contract values (3.1, decision 14, Consul API).
describe('routes', () => {
  it('own endpoints and the public prefix', () => {
    expect(PATHS).toEqual({ healthLive: '/health/live', healthReady: '/health/ready' });
    expect(GATEWAY_PREFIX).toBe('/api/v1');
  });

  it('JWKS of Auth Service', () => {
    expect(AUTH_JWKS_PATH).toBe('/.well-known/jwks.json');
  });

  it('Consul API, with the service id and name encoded', () => {
    expect(CONSUL_REGISTER_PATH).toBe('/v1/agent/service/register');
    expect(consulServicePath('api-gateway-a1')).toBe('/v1/agent/service/api-gateway-a1');
    expect(consulDeregisterPath('api-gateway-a1')).toBe('/v1/agent/service/deregister/api-gateway-a1');
    expect(consulServicePath('a/b c')).toBe('/v1/agent/service/a%2Fb%20c');
    expect(consulHealthyInstancesPath('user-service')).toBe('/v1/health/service/user-service?passing');
    expect(consulKvRawPath('config/api-gateway/data')).toBe('/v1/kv/config/api-gateway/data?raw');
  });
});
