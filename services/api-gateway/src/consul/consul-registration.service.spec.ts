import { jest } from '@jest/globals';
import type { PinoLogger } from 'nestjs-pino';
import { buildAppConfig } from '../config/app-config';
import { CONSUL_REGISTER_PATH, consulDeregisterPath, consulServicePath, PATHS } from '../routes';
import { ConsulRegistration } from './consul-registration.service';
import { LoopbackAddressError } from './service-address';

const ENV = { CONSUL_HOST: 'consul', REDIS_PASSWORD: 'test-redis' };

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

const notRegistered = (call: Call) => new Response('', { status: call.method === 'GET' ? 404 : 200 });

function createRegistration(env: Record<string, string> = ENV, route: () => Promise<string> = () => Promise.resolve('172.21.0.7')) {
  const logger = { info: jest.fn(), warn: jest.fn() };
  const config = buildAppConfig(env);
  const registration = new ConsulRegistration(config, logger as unknown as PinoLogger);
  const routeAddress = jest.fn(route);
  registration.routeAddress = routeAddress;
  return { registration, config, logger, routeAddress };
}

function registrations(calls: Call[]): Call[] {
  return calls.filter((call) => call.url.endsWith(CONSUL_REGISTER_PATH));
}

describe('ConsulRegistration', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('registers with ID, name, the address of the route to Consul, port and the HTTP check', async () => {
    const calls = fakeConsul(notRegistered);
    const { registration, config, routeAddress } = createRegistration();

    await registration.start(() => Promise.resolve(true));
    await registration.onApplicationShutdown();

    expect(routeAddress).toHaveBeenCalledWith('consul', 8500);
    const [register] = registrations(calls);
    expect(register.method).toBe('PUT');
    expect(JSON.parse(register.body ?? '{}')).toEqual({
      ID: config.instanceId,
      Name: 'api-gateway',
      Address: '172.21.0.7',
      Port: 8080,
      Check: {
        Status: 'passing',
        HTTP: `http://172.21.0.7:8080${PATHS.healthReady}`,
        Interval: '10s',
        Timeout: '2s',
        DeregisterCriticalServiceAfter: '1m',
      },
    });
    expect(config.instanceId).toMatch(/^api-gateway-/);
  });

  it('uses SERVICE_ADDRESS when it is set', async () => {
    const calls = fakeConsul(notRegistered);
    const { registration, routeAddress } = createRegistration({ ...ENV, SERVICE_ADDRESS: 'host.docker.internal' });
    await registration.start(() => Promise.resolve(true));
    await registration.onApplicationShutdown();
    expect(routeAddress).not.toHaveBeenCalled();
    expect(JSON.parse(registrations(calls)[0].body ?? '{}')).toMatchObject({ Address: 'host.docker.internal' });
  });

  it('registers as critical while the configuration is not loaded', async () => {
    const calls = fakeConsul(notRegistered);
    const { registration } = createRegistration();
    await registration.start(() => Promise.resolve(false));
    await registration.onApplicationShutdown();
    expect(JSON.parse(registrations(calls)[0].body ?? '{}')).toMatchObject({ Check: { Status: 'critical' } });
  });

  it('does not register again while Consul knows the current entry, and does after 404', async () => {
    let known = true;
    const calls = fakeConsul((call) =>
      call.method === 'GET'
        ? new Response(JSON.stringify({ Address: '172.21.0.7', Port: 8080 }), { status: known ? 200 : 404 })
        : new Response(''),
    );
    const { registration, config } = createRegistration();
    await registration.start(() => Promise.resolve(true));
    expect(calls[0].url).toBe(`http://consul:8500${consulServicePath(config.instanceId)}`);
    expect(registrations(calls)).toHaveLength(0);

    known = false; // e.g. the entry was removed in Consul
    await registration.ensureRegistered();
    expect(registrations(calls)).toHaveLength(1);
    await registration.onApplicationShutdown();
  });

  it('registers again when Consul keeps an entry with an old address or port', async () => {
    let stored = { Address: '172.21.0.99', Port: 8080 };
    const calls = fakeConsul((call) => (call.method === 'GET' ? new Response(JSON.stringify(stored)) : new Response('')));
    const { registration } = createRegistration();
    await registration.start(() => Promise.resolve(true));
    expect(registrations(calls)).toHaveLength(1);

    stored = { Address: '172.21.0.7', Port: 9999 };
    await registration.ensureRegistered();
    expect(registrations(calls)).toHaveLength(2);
    await registration.onApplicationShutdown();
  });

  it('fails the startup when the route to Consul is a loopback address', async () => {
    const calls = fakeConsul(notRegistered);
    const { registration } = createRegistration({ ...ENV, CONSUL_HOST: '127.0.0.1' }, () => Promise.resolve('127.0.0.1'));
    await expect(registration.start(() => Promise.resolve(true))).rejects.toBeInstanceOf(LoopbackAddressError);
    expect(registrations(calls)).toHaveLength(0);
  });

  it('starts when CONSUL_HOST does not resolve, warns once and resolves the address on a later attempt', async () => {
    let dnsWorks = false;
    const calls = fakeConsul(notRegistered);
    const { registration, logger, routeAddress } = createRegistration(ENV, () =>
      dnsWorks ? Promise.resolve('172.21.0.7') : Promise.reject(new Error('getaddrinfo ENOTFOUND consul')),
    );

    await registration.start(() => Promise.resolve(true));
    await registration.ensureRegistered();
    expect(registrations(calls)).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    dnsWorks = true;
    await registration.ensureRegistered();
    expect(routeAddress).toHaveBeenCalledTimes(4);
    expect(JSON.parse(registrations(calls)[0].body ?? '{}')).toMatchObject({ Address: '172.21.0.7' });
    expect(logger.info).toHaveBeenCalledWith('Consul is reachable again');
    // The address is known now: no more lookups.
    await registration.ensureRegistered();
    expect(routeAddress).toHaveBeenCalledTimes(4);
    await registration.onApplicationShutdown();
  });

  it('logs one warning while Consul is down and registers when it is back', async () => {
    let up = false;
    const calls = fakeConsul((call) => (up ? notRegistered(call) : new TypeError('fetch failed')));
    const { registration, logger } = createRegistration();

    await registration.start(() => Promise.resolve(true));
    await registration.ensureRegistered();
    await registration.ensureRegistered();
    expect(logger.warn).toHaveBeenCalledTimes(1);

    up = true;
    await registration.ensureRegistered();
    expect(registrations(calls)).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledWith('Consul is reachable again');
    await registration.onApplicationShutdown();
  });

  it('deregisters on shutdown', async () => {
    const calls = fakeConsul(() => new Response(''));
    const { registration, config } = createRegistration();
    await registration.onApplicationShutdown();
    expect(calls).toEqual([{ url: `http://consul:8500${consulDeregisterPath(config.instanceId)}`, method: 'PUT', body: undefined }]);
  });
});
