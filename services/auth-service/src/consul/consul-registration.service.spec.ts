import { jest } from '@jest/globals';
import type { PinoLogger } from 'nestjs-pino';
import { buildConfig, KV_DEFAULTS } from '../config/app-config';
import { CONSUL_REGISTER_PATH, consulDeregisterPath, consulServicePath, PATHS } from '../routes';
import { ConsulRegistration, resolveServiceAddress } from './consul-registration.service';

const ENV = {
  DB_HOST: 'postgres',
  DB_NAME: 'auth_db',
  DB_USER: 'auth_service',
  DB_PASSWORD: 'test-password',
  RABBITMQ_HOST: 'rabbitmq',
  RABBITMQ_USER: 'auth-service',
  RABBITMQ_PASSWORD: 'test-rabbitmq-password',
  CONSUL_HOST: 'consul',
  SERVICE_ADDRESS: '10.1.2.3',
};
const TOKEN = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';

interface Call {
  url: string;
  method: string;
  body?: string;
  // Value of the X-Consul-Token header.
  token?: string;
}

/** Fake Consul agent: answers by method and path, records the calls. */
function fakeConsul(answer: (call: Call) => Response | Error): Call[] {
  const calls: Call[] = [];
  jest.spyOn(global, 'fetch').mockImplementation((input, init) => {
    const call = {
      url: input as string,
      method: init?.method ?? 'GET',
      body: init?.body as string | undefined,
      token: (init?.headers as Record<string, string> | undefined)?.['X-Consul-Token'],
    };
    calls.push(call);
    const result = answer(call);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  return calls;
}

function createLogger() {
  return { info: jest.fn(), warn: jest.fn() };
}

function createRegistration(env: Record<string, string>, logger = createLogger()) {
  const config = buildConfig(env, KV_DEFAULTS);
  return { registration: new ConsulRegistration(config, logger as unknown as PinoLogger), config, logger };
}

describe('ConsulRegistration', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('registers with ID, name, address, port and the HTTP check', async () => {
    const calls = fakeConsul((call) => new Response('', { status: call.method === 'GET' ? 404 : 200 }));
    const { registration, config } = createRegistration(ENV);

    await registration.start(() => Promise.resolve(true));
    await registration.onApplicationShutdown();

    const register = calls.find((call) => call.url.endsWith(CONSUL_REGISTER_PATH));
    expect(register?.method).toBe('PUT');
    expect(JSON.parse(register?.body ?? '{}')).toEqual({
      ID: config.instanceId,
      Name: 'auth-service',
      Address: '10.1.2.3',
      Port: 8081,
      Check: {
        Status: 'passing',
        HTTP: `http://10.1.2.3:8081${PATHS.healthReady}`,
        Interval: '10s',
        Timeout: '2s',
        DeregisterCriticalServiceAfter: '1m',
      },
    });
  });

  it('registers again when Consul does not know the instance (404)', async () => {
    let known = true;
    const calls = fakeConsul((call) =>
      call.method === 'GET'
        ? new Response(JSON.stringify({ Address: '10.1.2.3', Port: 8081 }), { status: known ? 200 : 404 })
        : new Response(''),
    );
    const { registration } = createRegistration(ENV);
    await registration.start(() => Promise.resolve(true));
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(0);

    known = false; // e.g. the entry was removed in Consul
    await registration.ensureRegistered();
    const registrations = calls.filter((call) => call.url.endsWith(CONSUL_REGISTER_PATH));
    expect(registrations).toHaveLength(1);
    expect(JSON.parse(registrations[0].body ?? '{}')).toMatchObject({ Check: { Status: 'passing' } });
    await registration.onApplicationShutdown();
  });

  it('registers again when Consul keeps an entry with an old address', async () => {
    // Consul restored the registration of the previous container with the same hostname.
    const calls = fakeConsul((call) =>
      call.method === 'GET' ? new Response(JSON.stringify({ Address: '10.9.9.9', Port: 8081 })) : new Response(''),
    );
    const { registration } = createRegistration(ENV);

    await registration.start(() => Promise.resolve(true));
    await registration.onApplicationShutdown();

    expect(calls.filter((call) => call.url.endsWith(CONSUL_REGISTER_PATH))).toHaveLength(1);
  });

  it('logs one warning while Consul is down and registers when it is back', async () => {
    let up = false;
    const calls = fakeConsul((call) => {
      if (!up) {
        return new TypeError('fetch failed');
      }
      return new Response('', { status: call.method === 'GET' ? 404 : 200 });
    });
    const { registration, logger } = createRegistration(ENV);

    await registration.ensureRegistered();
    await registration.ensureRegistered();
    expect(logger.warn).toHaveBeenCalledTimes(1);

    up = true;
    await registration.ensureRegistered();
    expect(calls.filter((call) => call.url.endsWith(CONSUL_REGISTER_PATH))).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledWith('Consul is reachable again');
  });

  it('registers as critical when the service is not ready', async () => {
    const calls = fakeConsul((call) => new Response('', { status: call.method === 'GET' ? 404 : 200 }));
    const { registration } = createRegistration(ENV);

    await registration.start(() => Promise.resolve(false));
    await registration.onApplicationShutdown();

    const register = calls.find((call) => call.url.endsWith(CONSUL_REGISTER_PATH));
    expect(JSON.parse(register?.body ?? '{}')).toMatchObject({ Check: { Status: 'critical' } });
  });

  it('sends CONSUL_HTTP_TOKEN in X-Consul-Token on the check, the registration and the deregistration', async () => {
    const calls = fakeConsul((call) => new Response('', { status: call.method === 'GET' ? 404 : 200 }));
    const { registration, config } = createRegistration({ ...ENV, CONSUL_HTTP_TOKEN: TOKEN });

    await registration.start(() => Promise.resolve(true));
    await registration.onApplicationShutdown();

    expect(calls.map(({ url, method, token }) => ({ url, method, token }))).toEqual([
      { url: `http://consul:8500${consulServicePath(config.instanceId)}`, method: 'GET', token: TOKEN },
      { url: `http://consul:8500${CONSUL_REGISTER_PATH}`, method: 'PUT', token: TOKEN },
      { url: `http://consul:8500${consulDeregisterPath(config.instanceId)}`, method: 'PUT', token: TOKEN },
    ]);
  });

  it('sends no X-Consul-Token without CONSUL_HTTP_TOKEN (Docker Compose)', async () => {
    const calls = fakeConsul((call) => new Response('', { status: call.method === 'GET' ? 404 : 200 }));
    const { registration } = createRegistration(ENV);

    await registration.start(() => Promise.resolve(true));
    await registration.onApplicationShutdown();

    expect(calls).toHaveLength(3);
    expect(calls.filter((call) => call.token !== undefined)).toEqual([]);
  });

  it('a 403 from Consul (ACL) is one warning naming CONSUL_HTTP_TOKEN, never its value', async () => {
    // Consul answers 403 when the token may not register the name (e.g. no token for a reserved name).
    fakeConsul((call) => new Response('Permission denied', { status: call.method === 'GET' ? 404 : 403 }));
    const { registration, logger } = createRegistration({ ...ENV, CONSUL_HTTP_TOKEN: TOKEN });

    await registration.start(() => Promise.resolve(true));
    await registration.ensureRegistered();
    await registration.onApplicationShutdown();

    expect(logger.warn.mock.calls).toEqual([
      [
        { reason: 'Consul registration responded with 403 (ACL: CONSUL_HTTP_TOKEN missing or without permission)' },
        'Consul is not reachable, will retry the registration',
      ],
      [
        { reason: 'Consul deregistration responded with 403 (ACL: CONSUL_HTTP_TOKEN missing or without permission)' },
        'Deregistration from Consul failed',
      ],
    ]);
    expect(JSON.stringify([logger.warn.mock.calls, logger.info.mock.calls])).not.toContain(TOKEN);
  });

  it('deregisters on shutdown', async () => {
    const calls = fakeConsul(() => new Response(''));
    const { registration, config } = createRegistration(ENV);

    await registration.onApplicationShutdown();

    expect(calls).toEqual([
      { url: `http://consul:8500${consulDeregisterPath(config.instanceId)}`, method: 'PUT', body: undefined },
    ]);
  });

  it('does nothing when CONSUL_ENABLED=false', async () => {
    const calls = fakeConsul(() => new Response(''));
    const { registration } = createRegistration({ ...ENV, CONSUL_ENABLED: 'false' });

    await registration.start(() => Promise.resolve(true));
    await registration.onApplicationShutdown();

    expect(calls).toHaveLength(0);
  });
});

describe('resolveServiceAddress', () => {
  const loopback = { address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '', mac: '', cidr: null } as const;
  const ipv6 = { address: 'fe80::1', family: 'IPv6', internal: false, netmask: '', mac: '', cidr: null, scopeid: 1 } as const;
  const eth0 = { address: '172.20.0.5', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null } as const;

  it('prefers SERVICE_ADDRESS', () => {
    expect(resolveServiceAddress('host.docker.internal', { eth0: [eth0] })).toBe('host.docker.internal');
  });

  it('takes the first non-loopback IPv4 address', () => {
    expect(resolveServiceAddress('', { lo: [loopback], eth0: [ipv6, eth0] })).toBe('172.20.0.5');
  });

  it('fails when there is no such address', () => {
    expect(() => resolveServiceAddress('', { lo: [loopback] })).toThrow('SERVICE_ADDRESS');
  });
});
