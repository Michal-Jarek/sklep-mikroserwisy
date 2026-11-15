import { jest } from '@jest/globals';
import type { PinoLogger } from 'nestjs-pino';
import { buildAppConfig } from '../config/app-config';
import { CONSUL_REGISTER_PATH, consulDeregisterPath, consulServiceInstancesPath, consulServicePath, PATHS } from '../routes';
import { ConsulRegistration } from './consul-registration.service';
import { LoopbackAddressError } from './service-address';

const ENV = { CONSUL_HOST: 'consul', REDIS_PASSWORD: 'test-redis' };
const TOKEN = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';

interface Call {
  url: string;
  method: string;
  body?: string;
  // Value of the X-Consul-Token header.
  token?: string;
}

/**
 * Fake Consul agent: answers by method and path, records the calls. GET /v1/health/service/<name> (the cleanup of
 * orphaned entries at startup, Z7) is answered by `health`, by default with no entries.
 */
function fakeConsul(
  answer: (call: Call) => Response | Error,
  health: () => Response | Error = () => new Response('[]'),
): Call[] {
  const calls: Call[] = [];
  jest.spyOn(global, 'fetch').mockImplementation((input, init) => {
    const call = {
      url: input as string,
      method: init?.method ?? 'GET',
      body: init?.body as string | undefined,
      token: (init?.headers as Record<string, string> | undefined)?.['X-Consul-Token'],
    };
    calls.push(call);
    const result = call.url.includes('/v1/health/service/') ? health() : answer(call);
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

function deregistrations(calls: Call[]): Call[] {
  return calls.filter((call) => call.url.includes('/v1/agent/service/deregister/'));
}

function healthLookups(calls: Call[]): Call[] {
  return calls.filter((call) => call.url.includes('/v1/health/service/'));
}

/** One entry of GET /v1/health/service/<name>. */
function healthEntry(id: string, address: string, port: number, name = 'api-gateway') {
  return { Node: { Address: '127.0.0.9' }, Service: { ID: id, Service: name, Address: address, Port: port } };
}

/** Consul with an entry of this ID (address and port given), recording the calls. */
function consulWithEntry(entry: () => { Address: string; Port: number } | null, health?: () => Response | Error): Call[] {
  return fakeConsul((call) => {
    if (call.method !== 'GET') {
      return new Response('');
    }
    const stored = entry();
    return stored ? new Response(JSON.stringify(stored)) : new Response('', { status: 404 });
  }, health);
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

  it('registers without a deregistration when Consul has no entry of this ID', async () => {
    const calls = consulWithEntry(() => null);
    const { registration, config, logger } = createRegistration();
    await registration.start(() => Promise.resolve(true));

    expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET http://consul:8500${consulServicePath(config.instanceId)}`,
      `GET http://consul:8500${consulServiceInstancesPath('api-gateway')}`,
      `PUT http://consul:8500${CONSUL_REGISTER_PATH}`,
    ]);
    expect(logger.info).not.toHaveBeenCalledWith(expect.anything(), 'Removed the entry of the previous process from Consul');
    await registration.onApplicationShutdown();
  });

  it('removes the entry of the previous process with the same ID and address, then registers', async () => {
    // The same container started again after docker kill: same hostname (ID) and address, check still critical.
    const calls = consulWithEntry(() => ({ Address: '172.21.0.7', Port: 8080 }));
    const { registration, config, logger } = createRegistration();
    await registration.start(() => Promise.resolve(true));

    expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET http://consul:8500${consulServicePath(config.instanceId)}`,
      `GET http://consul:8500${consulServiceInstancesPath('api-gateway')}`,
      `PUT http://consul:8500${consulDeregisterPath(config.instanceId)}`,
      `PUT http://consul:8500${CONSUL_REGISTER_PATH}`,
    ]);
    expect(JSON.parse(registrations(calls)[0].body ?? '{}')).toMatchObject({ Check: { Status: 'passing' } });
    expect(logger.info).toHaveBeenCalledWith(
      { instanceId: config.instanceId },
      'Removed the entry of the previous process from Consul',
    );
    await registration.onApplicationShutdown();
  });

  it('does not deregister or register again while Consul knows the current entry, and registers after 404', async () => {
    let known = true;
    const calls = consulWithEntry(() => (known ? { Address: '172.21.0.7', Port: 8080 } : null));
    const { registration } = createRegistration();
    await registration.start(() => Promise.resolve(true));
    expect(deregistrations(calls)).toHaveLength(1);
    expect(registrations(calls)).toHaveLength(1);

    await registration.ensureRegistered();
    await registration.ensureRegistered();
    expect(registrations(calls)).toHaveLength(1);

    known = false; // e.g. the entry was removed in Consul
    await registration.ensureRegistered();
    expect(registrations(calls)).toHaveLength(2);
    expect(deregistrations(calls)).toHaveLength(1);
    await registration.onApplicationShutdown();
  });

  it('registers again when Consul keeps an entry with an old address or port, deregistering only at the start', async () => {
    let stored = { Address: '172.21.0.99', Port: 8080 };
    const calls = consulWithEntry(() => stored);
    const { registration } = createRegistration();
    await registration.start(() => Promise.resolve(true));
    expect(deregistrations(calls)).toHaveLength(1);
    expect(registrations(calls)).toHaveLength(1);

    stored = { Address: '172.21.0.7', Port: 9999 };
    await registration.ensureRegistered();
    expect(registrations(calls)).toHaveLength(2);
    expect(deregistrations(calls)).toHaveLength(1);
    await registration.onApplicationShutdown();
  });

  it('removes the old entry at the first successful contact when Consul was down at the start', async () => {
    let up = false;
    const answer = (call: Call) =>
      call.method === 'GET' ? new Response(JSON.stringify({ Address: '172.21.0.7', Port: 8080 })) : new Response('');
    const calls = fakeConsul((call) => (up ? answer(call) : new TypeError('fetch failed')));
    const { registration, logger } = createRegistration();
    await registration.start(() => Promise.resolve(true));
    expect(registrations(calls)).toHaveLength(0);
    expect(deregistrations(calls)).toHaveLength(0);

    up = true;
    await registration.ensureRegistered();
    expect(deregistrations(calls)).toHaveLength(1);
    expect(registrations(calls)).toHaveLength(1);
    expect(calls.findIndex((call) => call.url.includes('/deregister/'))).toBeLessThan(
      calls.findIndex((call) => call.url.endsWith(CONSUL_REGISTER_PATH)),
    );
    expect(logger.info).toHaveBeenCalledWith(expect.anything(), 'Removed the entry of the previous process from Consul');

    await registration.ensureRegistered();
    expect(deregistrations(calls)).toHaveLength(1);
    expect(registrations(calls)).toHaveLength(1);
    await registration.onApplicationShutdown();
  });

  it('does not register when removing the old entry fails, and repeats both on the next check', async () => {
    // e.g. consul-guard refuses the deregistration (entry with another address).
    let refuse = true;
    const calls = fakeConsul((call) => {
      if (call.method === 'GET') {
        return new Response(JSON.stringify({ Address: '172.21.0.7', Port: 8080 }));
      }
      return new Response('', { status: refuse && call.url.includes('/deregister/') ? 403 : 200 });
    });
    const { registration, logger } = createRegistration();
    await registration.start(() => Promise.resolve(true));
    expect(registrations(calls)).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    refuse = false;
    await registration.ensureRegistered();
    expect(deregistrations(calls)).toHaveLength(2);
    expect(registrations(calls)).toHaveLength(1);
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

  describe('Z7: orphaned entries with the address of this instance at the first registration', () => {
    const ORPHAN = 'Removed an orphaned entry with the address of this instance from Consul';
    const CLEANUP_FAILED = 'Cleanup of orphaned Consul entries failed, registering anyway';

    it('removes entries with the same address and port but another ID, then registers', async () => {
      const calls = consulWithEntry(
        () => null,
        () => new Response(JSON.stringify([healthEntry('api-gateway-old1', '172.21.0.7', 8080), healthEntry('api-gateway-old2', '172.21.0.7', 8080)])),
      );
      const { registration, config, logger } = createRegistration();
      await registration.start(() => Promise.resolve(true));

      expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
        `GET http://consul:8500${consulServicePath(config.instanceId)}`,
        `GET http://consul:8500${consulServiceInstancesPath('api-gateway')}`,
        `PUT http://consul:8500${consulDeregisterPath('api-gateway-old1')}`,
        `PUT http://consul:8500${consulDeregisterPath('api-gateway-old2')}`,
        `PUT http://consul:8500${CONSUL_REGISTER_PATH}`,
      ]);
      expect(logger.info).toHaveBeenCalledWith({ instanceId: 'api-gateway-old1' }, ORPHAN);
      expect(logger.info).toHaveBeenCalledWith({ instanceId: 'api-gateway-old2' }, ORPHAN);
      expect(logger.warn).not.toHaveBeenCalled();
      await registration.onApplicationShutdown();
    });

    it('leaves entries with another address, another port or another service name untouched', async () => {
      const calls = consulWithEntry(
        () => null,
        () =>
          new Response(
            JSON.stringify([
              healthEntry('api-gateway-a', '172.21.0.8', 8080),
              healthEntry('api-gateway-b', '172.21.0.7', 9999),
              healthEntry('API-GATEWAY-c', '172.21.0.7', 8080, 'API-GATEWAY'),
              null,
            ]),
          ),
      );
      const { registration, logger } = createRegistration();
      await registration.start(() => Promise.resolve(true));

      expect(deregistrations(calls)).toHaveLength(0);
      expect(registrations(calls)).toHaveLength(1);
      expect(logger.warn).not.toHaveBeenCalled();
      await registration.onApplicationShutdown();
    });

    it('its own ID in the list is not an orphan: the Z5 path removes it once and registers', async () => {
      let ownId = '';
      const calls = consulWithEntry(
        () => ({ Address: '172.21.0.7', Port: 8080 }),
        () => new Response(JSON.stringify([healthEntry(ownId, '172.21.0.7', 8080)])),
      );
      const { registration, config } = createRegistration();
      ownId = config.instanceId;
      await registration.start(() => Promise.resolve(true));

      expect(deregistrations(calls).map((call) => call.url)).toEqual([
        `http://consul:8500${consulDeregisterPath(config.instanceId)}`,
      ]);
      expect(registrations(calls)).toHaveLength(1);
      await registration.onApplicationShutdown();
    });

    it.each([
      ['an error status', () => new Response('', { status: 500 })],
      ['a response that is not a list', () => new Response('{}')],
      ['invalid JSON', () => new Response('not json')],
    ])('a failed cleanup (%s) is one warning and the instance is registered anyway', async (_name, health) => {
      const calls = consulWithEntry(() => null, health);
      const { registration, logger } = createRegistration();
      await registration.start(() => Promise.resolve(true));

      expect(registrations(calls)).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][1]).toBe(CLEANUP_FAILED);
      await registration.onApplicationShutdown();
    });

    it('Consul not reachable during the cleanup ends the attempt; the next one cleans up and registers', async () => {
      let healthUp = false;
      const calls = consulWithEntry(
        () => null,
        () => (healthUp ? new Response('[]') : new TypeError('fetch failed')),
      );
      const { registration, logger } = createRegistration();
      await registration.start(() => Promise.resolve(true));
      await registration.ensureRegistered();
      expect(registrations(calls)).toHaveLength(0);
      expect(logger.warn.mock.calls.map((call) => call[1])).toEqual(['Consul is not reachable, will retry the registration']);

      healthUp = true;
      await registration.ensureRegistered();
      expect(healthLookups(calls)).toHaveLength(3);
      expect(registrations(calls)).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      await registration.onApplicationShutdown();
    });

    it('a refused deregistration of an orphan is one warning and the instance is registered anyway', async () => {
      const calls = fakeConsul(
        (call) => {
          if (call.method === 'GET') {
            return new Response('', { status: 404 });
          }
          return new Response('', { status: call.url.includes('/deregister/') ? 403 : 200 });
        },
        () => new Response(JSON.stringify([healthEntry('api-gateway-old', '172.21.0.7', 8080)])),
      );
      const { registration, logger } = createRegistration();
      await registration.start(() => Promise.resolve(true));

      expect(registrations(calls)).toHaveLength(1);
      expect(logger.warn.mock.calls.map((call) => call[1])).toEqual([CLEANUP_FAILED]);
    });

    it('CR-34: two orphans, the first refused (403) -> the second is still removed, one warning after the loop', async () => {
      const calls = fakeConsul(
        (call) => {
          if (call.method === 'GET') {
            return new Response('', { status: 404 });
          }
          return new Response('', { status: call.url.endsWith('/api-gateway-old1') ? 403 : 200 });
        },
        () =>
          new Response(
            JSON.stringify([healthEntry('api-gateway-old1', '172.21.0.7', 8080), healthEntry('api-gateway-old2', '172.21.0.7', 8080)]),
          ),
      );
      const { registration, logger } = createRegistration();
      await registration.start(() => Promise.resolve(true));

      expect(deregistrations(calls).map((call) => call.url)).toEqual([
        `http://consul:8500${consulDeregisterPath('api-gateway-old1')}`,
        `http://consul:8500${consulDeregisterPath('api-gateway-old2')}`,
      ]);
      expect(logger.info).toHaveBeenCalledWith({ instanceId: 'api-gateway-old2' }, ORPHAN);
      expect(logger.info).not.toHaveBeenCalledWith({ instanceId: 'api-gateway-old1' }, ORPHAN);
      expect(logger.warn.mock.calls).toEqual([
        [
          { failed: 1, reason: 'Consul deregistration responded with 403 (ACL: CONSUL_HTTP_TOKEN missing or without permission)' },
          CLEANUP_FAILED,
        ],
      ]);
      expect(registrations(calls)).toHaveLength(1);
    });

    it('cleans up only at the first registration, not on the periodic checks', async () => {
      let known = false;
      const calls = consulWithEntry(
        () => (known ? { Address: '172.21.0.7', Port: 8080 } : null),
        () => new Response(JSON.stringify([healthEntry('api-gateway-old', '172.21.0.7', 8080)])),
      );
      const { registration } = createRegistration();
      await registration.start(() => Promise.resolve(true));
      expect(healthLookups(calls)).toHaveLength(1);

      known = true;
      await registration.ensureRegistered();
      known = false; // the entry disappeared: registered again, still without a cleanup
      await registration.ensureRegistered();
      expect(healthLookups(calls)).toHaveLength(1);
      expect(registrations(calls)).toHaveLength(2);
      expect(deregistrations(calls)).toHaveLength(1);
      await registration.onApplicationShutdown();
    });

    it('cleans up at the first successful contact when Consul was down at the start', async () => {
      let up = false;
      const calls = fakeConsul(
        (call) => (up ? new Response('', { status: call.method === 'GET' ? 404 : 200 }) : new TypeError('fetch failed')),
        () => new Response(JSON.stringify([healthEntry('api-gateway-old', '172.21.0.7', 8080)])),
      );
      const { registration } = createRegistration();
      await registration.start(() => Promise.resolve(true));
      expect(healthLookups(calls)).toHaveLength(0);

      up = true;
      await registration.ensureRegistered();
      expect(healthLookups(calls)).toHaveLength(1);
      expect(deregistrations(calls).map((call) => call.url)).toEqual([
        `http://consul:8500${consulDeregisterPath('api-gateway-old')}`,
      ]);
      expect(registrations(calls)).toHaveLength(1);
      await registration.onApplicationShutdown();
    });
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

  it('sends CONSUL_HTTP_TOKEN in X-Consul-Token on the check, the registration and the deregistration', async () => {
    const calls = fakeConsul(notRegistered);
    const { registration, config } = createRegistration({ ...ENV, CONSUL_HTTP_TOKEN: TOKEN });

    await registration.start(() => Promise.resolve(true));
    await registration.onApplicationShutdown();

    expect(calls.map(({ url, method, token }) => ({ url, method, token }))).toEqual([
      { url: `http://consul:8500${consulServicePath(config.instanceId)}`, method: 'GET', token: TOKEN },
      { url: `http://consul:8500${consulServiceInstancesPath('api-gateway')}`, method: 'GET', token: TOKEN },
      { url: `http://consul:8500${CONSUL_REGISTER_PATH}`, method: 'PUT', token: TOKEN },
      { url: `http://consul:8500${consulDeregisterPath(config.instanceId)}`, method: 'PUT', token: TOKEN },
    ]);
  });

  it('sends no X-Consul-Token without CONSUL_HTTP_TOKEN (Docker Compose)', async () => {
    const calls = fakeConsul(notRegistered);
    const { registration } = createRegistration();

    await registration.start(() => Promise.resolve(true));
    await registration.onApplicationShutdown();

    expect(calls).toHaveLength(4);
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
    const { registration, config } = createRegistration();
    await registration.onApplicationShutdown();
    expect(calls).toEqual([{ url: `http://consul:8500${consulDeregisterPath(config.instanceId)}`, method: 'PUT', body: undefined }]);
  });
});
