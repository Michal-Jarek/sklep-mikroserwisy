import { jest } from '@jest/globals';
import type { PinoLogger } from 'nestjs-pino';
import { buildConfig, KV_DEFAULTS } from '../config/app-config';
import { consulHealthyInstancesPath } from '../routes';
import { ServiceDiscovery } from './service-discovery.service';

const ENV = {
  DB_HOST: 'postgres',
  DB_NAME: 'auth_db',
  DB_USER: 'auth_service',
  DB_PASSWORD: 'test-password',
  CONSUL_HOST: 'consul',
};

function instance(address: string, port: number) {
  return { Node: { Address: '127.0.0.1' }, Service: { Address: address, Port: port } };
}

function mockConsulHealth(answer: () => Response | Error) {
  return jest.spyOn(global, 'fetch').mockImplementation(() => {
    const result = answer();
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
}

function createDiscovery(env: Record<string, string> = ENV) {
  const logger = { warn: jest.fn() };
  const discovery = new ServiceDiscovery(buildConfig(env, KV_DEFAULTS), logger as unknown as PinoLogger);
  return { discovery, logger };
}

describe('ServiceDiscovery', () => {
  let now = 1_000_000;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('asks Consul for passing instances and uses them in turn (round robin)', async () => {
    const fetchSpy = mockConsulHealth(
      () => new Response(JSON.stringify([instance('10.0.0.1', 8082), instance('10.0.0.2', 8082)])),
    );
    const { discovery } = createDiscovery();

    const picked = [
      await discovery.getInstance('user-service'),
      await discovery.getInstance('user-service'),
      await discovery.getInstance('user-service'),
    ];

    expect(picked).toEqual(['http://10.0.0.1:8082', 'http://10.0.0.2:8082', 'http://10.0.0.1:8082']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0] as string).toBe(`http://consul:8500${consulHealthyInstancesPath('user-service')}`);
  });

  it('reuses the list for 10 s and asks Consul again after that', async () => {
    const fetchSpy = mockConsulHealth(() => new Response(JSON.stringify([instance('10.0.0.1', 8082)])));
    const { discovery } = createDiscovery();

    await discovery.getInstance('user-service');
    now += 9_999;
    await discovery.getInstance('user-service');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    now += 2;
    await discovery.getInstance('user-service');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('uses the node address when the service has none', async () => {
    mockConsulHealth(() => new Response(JSON.stringify([instance('', 8082)])));
    const { discovery } = createDiscovery();
    expect(await discovery.getInstance('user-service')).toBe('http://127.0.0.1:8082');
  });

  it('returns null when there is no healthy instance', async () => {
    mockConsulHealth(() => new Response('[]'));
    const { discovery } = createDiscovery();
    expect(await discovery.getInstance('user-service')).toBeNull();
  });

  it('returns null and logs a warning when Consul fails', async () => {
    mockConsulHealth(() => new TypeError('fetch failed'));
    const { discovery, logger } = createDiscovery();
    expect(await discovery.getInstance('user-service')).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('returns null and logs a warning when Consul answers with an error status', async () => {
    mockConsulHealth(() => new Response('', { status: 500 }));
    const { discovery, logger } = createDiscovery();
    expect(await discovery.getInstance('user-service')).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('returns null without calling Consul when CONSUL_ENABLED=false', async () => {
    const fetchSpy = mockConsulHealth(() => new Response('[]'));
    const { discovery } = createDiscovery({ ...ENV, CONSUL_ENABLED: 'false' });
    expect(await discovery.getInstance('user-service')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
