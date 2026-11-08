import {
  CONSUL_REGISTER_PATH,
  consulDeregisterPath,
  consulHealthyInstancesPath,
  consulKvRawPath,
  consulServicePath,
  PATHS,
  REFRESH_COOKIE_PATH,
  ROUTES,
  USER_SERVICE_USERS_PATH,
} from './routes';

// The other tests use the constants; this one pins the contract values (3.1, 3.2, decision 17, Consul API).
describe('routes', () => {
  it('own endpoints', () => {
    expect(PATHS).toEqual({
      register: '/auth/register',
      login: '/auth/login',
      refresh: '/auth/refresh',
      logout: '/auth/logout',
      healthLive: '/health/live',
      healthReady: '/health/ready',
      jwks: '/.well-known/jwks.json',
    });
    expect(ROUTES.docs).toEqual({ ui: 'docs', openApi: 'openapi.json' });
  });

  it('refresh cookie path and User Service', () => {
    expect(REFRESH_COOKIE_PATH).toBe('/api/v1/auth');
    expect(USER_SERVICE_USERS_PATH).toBe('/users');
  });

  it('Consul API, with the service id and name encoded', () => {
    expect(CONSUL_REGISTER_PATH).toBe('/v1/agent/service/register');
    expect(consulServicePath('auth-service-a1')).toBe('/v1/agent/service/auth-service-a1');
    expect(consulDeregisterPath('auth-service-a1')).toBe('/v1/agent/service/deregister/auth-service-a1');
    expect(consulServicePath('a/b c')).toBe('/v1/agent/service/a%2Fb%20c');
    expect(consulHealthyInstancesPath('user-service')).toBe('/v1/health/service/user-service?passing');
    expect(consulKvRawPath('config/auth-service/data')).toBe('/v1/kv/config/auth-service/data?raw');
  });
});
