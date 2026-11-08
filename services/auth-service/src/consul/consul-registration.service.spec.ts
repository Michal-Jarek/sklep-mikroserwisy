import { jest } from '@jest/globals';
import type { PinoLogger } from 'nestjs-pino';
import { buildConfig, KV_DEFAULTS } from '../config/app-config';
import { CONSUL_REGISTER_PATH, consulDeregisterPath, PATHS } from '../routes';
import { ConsulRegistration, resolveServiceAddress } from './consul-registration.service';

const ENV = {
  DB_HOST: 'postgres',
  DB_NAME: 'auth_db',
  DB_USER: 'auth_service',
  DB_PASSWORD: 'test-password',
  CONSUL_HOST: 'consul',
  SERVICE_ADDRESS: '10.1.2.3',
};

interface Call {
  url: string;
  method: string;
  body?: string;
}

/** Fake Consul agent: answers by method and path, records the calls. */
function fakeConsul(answer: (call: Call) => Response | Error): Call[] {
  const calls: Call[] = [];
  jest.spyOn(global, 'fetch').mockImplementation((input, init) => {
    const call = { url: input as string, method: init?.method ?? 'GET', body: init?.body as string | undefined };
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
