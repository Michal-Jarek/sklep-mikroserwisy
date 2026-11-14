import { jest } from '@jest/globals';
import type { PinoLogger } from 'nestjs-pino';
import { buildAppConfig } from '../config/app-config';
import { GatewayMetrics } from '../metrics/gateway-metrics';
import { consulHealthyInstancesPath } from '../routes';
import { DISCOVERY_CACHE_MS, DISCOVERY_EMPTY_CACHE_MS, parseHealthyInstances, ServiceDiscovery } from './service-discovery.service';

const ENV = { CONSUL_HOST: 'consul', REDIS_PASSWORD: 'test-redis' };

function entry(id: string, address: string, port = 9000, service = 'product-service') {
  return { Node: { Address: '127.0.0.1' }, Service: { ID: id, Service: service, Address: address, Port: port } };
}

const THREE = [entry('stub-3', '10.0.0.3'), entry('stub-1', '10.0.0.1'), entry('stub-2', '10.0.0.2')];

type Answer = () => Response | Error | Promise<Response>;

function mockConsul(initial: Answer) {
  let answer = initial;
  const spy = jest.spyOn(global, 'fetch').mockImplementation(() => {
    const result = answer();
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  return { spy, set: (next: Answer) => (answer = next) };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body));
}

function createDiscovery(env: Record<string, string> = ENV) {
  const logger = { info: jest.fn(), warn: jest.fn() };
  const metrics = new GatewayMetrics('api-gateway-test');
  const discovery = new ServiceDiscovery(buildAppConfig(env), logger as unknown as PinoLogger, metrics);
  return { discovery, logger, metrics };
}

/** gateway_upstream_instances of the service, undefined before the first list from Consul. */
async function instancesGauge(metrics: GatewayMetrics, service: string): Promise<number | undefined> {
  const metric = await metrics.registry.getSingleMetric('gateway_upstream_instances')?.get();
  return metric?.values.find((value) => value.labels.service === service)?.value;
}

async function ids(discovery: ServiceDiscovery, service: string, count: number): Promise<(string | undefined)[]> {
  const picked: (string | undefined)[] = [];
  for (let i = 0; i < count; i += 1) {
    picked.push((await discovery.getInstance(service))?.id);
  }
  return picked;
}

describe('ServiceDiscovery', () => {
  let now = 1_000_000;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('asks Consul for passing instances and returns them in turn, sorted by id', async () => {
    const consul = mockConsul(() => json(THREE));
    const { discovery } = createDiscovery();

    expect(await discovery.getInstance('product-service')).toEqual({ id: 'stub-1', address: '10.0.0.1', port: 9000 });
    expect(await ids(discovery, 'product-service', 5)).toEqual(['stub-2', 'stub-3', 'stub-1', 'stub-2', 'stub-3']);
    expect(consul.spy).toHaveBeenCalledTimes(1);
    expect(consul.spy.mock.calls[0][0] as string).toBe(`http://consul:8500${consulHealthyInstancesPath('product-service')}`);
  });

  it('spreads 9 requests 3x3 and keeps the counter across refreshes', async () => {
    mockConsul(() => json(THREE));
    const { discovery } = createDiscovery();
    const picked = await ids(discovery, 'product-service', 4);
    now += DISCOVERY_CACHE_MS; // refresh with the same list in another order from Consul
    picked.push(...(await ids(discovery, 'product-service', 5)));
    const counts = picked.reduce<Record<string, number>>((acc, id) => ({ ...acc, [id ?? '']: (acc[id ?? ''] ?? 0) + 1 }), {});
    expect(counts).toEqual({ 'stub-1': 3, 'stub-2': 3, 'stub-3': 3 });
    expect(picked.slice(3, 5)).toEqual(['stub-1', 'stub-2']);
  });

  it('keeps a round robin counter per service', async () => {
    const review = THREE.map((item) => ({ ...item, Service: { ...item.Service, Service: 'review-service' } }));
    jest
      .spyOn(global, 'fetch')
      .mockImplementation((url) =>
        Promise.resolve(json((url as string).endsWith(consulHealthyInstancesPath('review-service')) ? review : THREE)),
      );
    const { discovery } = createDiscovery();
    await ids(discovery, 'product-service', 2);
    expect((await discovery.getInstance('review-service'))?.id).toBe('stub-1');
  });

  it('reuses the list for 10 s and asks Consul again after that', async () => {
    const consul = mockConsul(() => json([entry('stub-1', '10.0.0.1')]));
    const { discovery } = createDiscovery();

    await discovery.getInstance('product-service');
    now += DISCOVERY_CACHE_MS - 1;
    await discovery.getInstance('product-service');
    expect(consul.spy).toHaveBeenCalledTimes(1);

    now += 1;
    await discovery.getInstance('product-service');
    expect(consul.spy).toHaveBeenCalledTimes(2);
  });

  it('sends one request to Consul per service when many callers ask at once', async () => {
    let release: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => (release = resolve));
    const consul = mockConsul(() => answered.then(() => json(THREE)));
    const { discovery } = createDiscovery();

    const pending = Promise.all([1, 2, 3, 4].map(() => discovery.getInstance('product-service')));
    release();
    const picked = await pending;

    expect(consul.spy).toHaveBeenCalledTimes(1);
    expect(picked.map((instance) => instance?.id)).toEqual(['stub-1', 'stub-2', 'stub-3', 'stub-1']);
  });

  it('caches an empty list from Consul as a valid answer (null = no healthy instance)', async () => {
    const consul = mockConsul(() => json([]));
    const { discovery, logger } = createDiscovery();
    expect(await discovery.getInstance('order-service')).toBeNull();
    expect(await discovery.getInstance('order-service')).toBeNull();
    expect(consul.spy).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('asks Consul again after 2 s when the list was empty (a service that starts after the Gateway)', async () => {
    const consul = mockConsul(() => json([]));
    const { discovery } = createDiscovery();
    expect(await discovery.getInstance('auth-service')).toBeNull();

    consul.set(() => json([entry('auth-1', '10.0.0.7', 8081, 'auth-service')]));
    now += DISCOVERY_EMPTY_CACHE_MS - 1;
    expect(await discovery.getInstance('auth-service')).toBeNull();
    expect(consul.spy).toHaveBeenCalledTimes(1);

    now += 1;
    expect(await discovery.getInstance('auth-service')).toEqual({ id: 'auth-1', address: '10.0.0.7', port: 8081 });
    expect(consul.spy).toHaveBeenCalledTimes(2);

    // A non-empty list is kept for the full 10 s.
    now += DISCOVERY_EMPTY_CACHE_MS;
    await discovery.getInstance('auth-service');
    expect(consul.spy).toHaveBeenCalledTimes(2);
  });

  it('asks Consul again after 2 s when evict emptied the list (S5: a new instance is used without waiting 10 s)', async () => {
    const consul = mockConsul(() => json([entry('cart-1', '10.0.0.9', 9000, 'cart-service')]));
    const { discovery } = createDiscovery();
    const instance = await discovery.getInstance('cart-service');
    expect(instance).not.toBeNull();
    discovery.evict('cart-service', instance as NonNullable<typeof instance>);

    consul.set(() => json([entry('cart-2', '10.0.0.10', 9000, 'cart-service')]));
    now += DISCOVERY_EMPTY_CACHE_MS - 1;
    expect(await discovery.getInstance('cart-service')).toBeNull();
    expect(consul.spy).toHaveBeenCalledTimes(1);

    now += 1;
    expect((await discovery.getInstance('cart-service'))?.id).toBe('cart-2');
    expect(consul.spy).toHaveBeenCalledTimes(2);
  });

  it('a dead instance still in Consul is asked for at most every 2 s after it emptied the list', async () => {
    const consul = mockConsul(() => json([entry('cart-1', '10.0.0.9', 9000, 'cart-service')]));
    const { discovery } = createDiscovery();
    for (let i = 0; i < 3; i += 1) {
      const instance = await discovery.getInstance('cart-service');
      discovery.evict('cart-service', instance as NonNullable<typeof instance>);
      expect(await discovery.getInstance('cart-service')).toBeNull();
      now += DISCOVERY_EMPTY_CACHE_MS;
    }
    expect(consul.spy).toHaveBeenCalledTimes(3);
  });

  it('a list that still has instances after evict waits for the regular 10 s refresh', async () => {
    const consul = mockConsul(() => json(THREE));
    const { discovery } = createDiscovery();
    const first = await discovery.getInstance('product-service');
    discovery.evict('product-service', first!);
    now += DISCOVERY_EMPTY_CACHE_MS;
    await ids(discovery, 'product-service', 2);
    expect(consul.spy).toHaveBeenCalledTimes(1);
  });

  it('uses the node address when the service has none and skips incomplete entries', () => {
    expect(
      parseHealthyInstances(
        [
          entry('a', ''),
          { Service: { ID: 'b', Service: 'product-service', Address: '10.0.0.2' } },
          { Service: { Service: 'product-service', Address: '10.0.0.3', Port: 1 } },
          null,
        ],
        'product-service',
      ),
    ).toEqual([{ id: 'a', address: '127.0.0.1', port: 9000 }]);
    expect(() => parseHealthyInstances({}, 'product-service')).toThrow();
  });

  it('keeps only entries with exactly the requested name (Consul matches the name without case)', async () => {
    const consul = mockConsul(() =>
      json([entry('auth-1', '10.0.0.7', 8081, 'auth-service'), entry('fake-1', '10.0.0.66', 8081, 'AUTH-SERVICE')]),
    );
    const { discovery } = createDiscovery();
    expect(await ids(discovery, 'auth-service', 3)).toEqual(['auth-1', 'auth-1', 'auth-1']);
    expect(consul.spy).toHaveBeenCalledTimes(1);
  });

  it('keeps the last known list when Consul fails, warns once and informs when it is back', async () => {
    const consul = mockConsul(() => json(THREE));
    const { discovery, logger } = createDiscovery();
    await ids(discovery, 'product-service', 3);

    for (const failure of [() => new TypeError('fetch failed'), () => new Response('', { status: 500 }), () => new Response('not json')]) {
      consul.set(failure);
      now += DISCOVERY_CACHE_MS;
      expect((await discovery.getInstance('product-service'))?.id).toBeDefined();
    }
    expect(consul.spy).toHaveBeenCalledTimes(4);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toContain('Consul');

    consul.set(() => json(THREE));
    now += DISCOVERY_CACHE_MS;
    await discovery.getInstance('product-service');
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('does not ask Consul again for 10 s after a failure', async () => {
    const consul = mockConsul(() => json(THREE));
    const { discovery } = createDiscovery();
    await discovery.getInstance('product-service');
    consul.set(() => new Error('The operation was aborted due to timeout'));
    now += DISCOVERY_CACHE_MS;
    await discovery.getInstance('product-service');
    expect(consul.spy).toHaveBeenCalledTimes(2);

    now += DISCOVERY_CACHE_MS - 1;
    await ids(discovery, 'product-service', 5);
    expect(consul.spy).toHaveBeenCalledTimes(2);
    now += 1;
    await discovery.getInstance('product-service');
    expect(consul.spy).toHaveBeenCalledTimes(3);
  });

  it('asks Consul with CONSUL_HTTP_TOKEN in X-Consul-Token; a 403 (ACL) is one warning without the token', async () => {
    const token = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';
    const consul = mockConsul(() => new Response('Permission denied', { status: 403 }));
    const { discovery, logger } = createDiscovery({ ...ENV, CONSUL_HTTP_TOKEN: token });

    expect(await discovery.getInstance('product-service')).toBeNull();

    expect(consul.spy.mock.calls[0][0]).toBe(`http://consul:8500${consulHealthyInstancesPath('product-service')}`);
    expect(consul.spy.mock.calls[0][1]?.headers).toEqual({ 'X-Consul-Token': token });
    expect(logger.warn.mock.calls).toEqual([
      [
        {
          targetService: 'product-service',
          reason: 'Consul responded with 403 (ACL: CONSUL_HTTP_TOKEN missing or without permission)',
        },
        'Consul service discovery failed, using the last known instances',
      ],
    ]);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(token);
  });

  it('returns null when Consul fails and there is no list yet', async () => {
    mockConsul(() => new TypeError('fetch failed'));
    const { discovery, logger } = createDiscovery();
    expect(await discovery.getInstance('product-service')).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('evict drops an instance until the next refresh from Consul', async () => {
    const consul = mockConsul(() => json(THREE));
    const { discovery } = createDiscovery();
    const first = await discovery.getInstance('product-service');
    discovery.evict('product-service', first!);
    expect(await ids(discovery, 'product-service', 4)).toEqual(['stub-3', 'stub-2', 'stub-3', 'stub-2']);
    discovery.evict('unknown-service', first!);

    now += DISCOVERY_CACHE_MS;
    expect(new Set(await ids(discovery, 'product-service', 3))).toEqual(new Set(['stub-1', 'stub-2', 'stub-3']));
    expect(consul.spy).toHaveBeenCalledTimes(2);
  });

  it('returns null after the last instance is evicted', async () => {
    mockConsul(() => json([entry('stub-1', '10.0.0.1')]));
    const { discovery } = createDiscovery();
    const only = await discovery.getInstance('product-service');
    discovery.evict('product-service', only!);
    expect(await discovery.getInstance('product-service')).toBeNull();
  });

  it('gateway_upstream_instances: the list length after every refresh from Consul and after evict (K1)', async () => {
    const consul = mockConsul(() => json(THREE));
    const { discovery, metrics } = createDiscovery();
    expect(await instancesGauge(metrics, 'product-service')).toBeUndefined();

    const first = await discovery.getInstance('product-service');
    expect(await instancesGauge(metrics, 'product-service')).toBe(3);
    discovery.evict('product-service', first!);
    expect(await instancesGauge(metrics, 'product-service')).toBe(2);
    // evict of a service without a list sets nothing.
    discovery.evict('cart-service', first!);
    expect(await instancesGauge(metrics, 'cart-service')).toBeUndefined();

    // A failed refresh keeps the last known list (and the value).
    consul.set(() => new TypeError('fetch failed'));
    now += DISCOVERY_CACHE_MS;
    await discovery.getInstance('product-service');
    expect(await instancesGauge(metrics, 'product-service')).toBe(2);

    consul.set(() => json([entry('stub-1', '10.0.0.1')]));
    now += DISCOVERY_CACHE_MS;
    await discovery.getInstance('product-service');
    expect(await instancesGauge(metrics, 'product-service')).toBe(1);

    consul.set(() => json([]));
    now += DISCOVERY_CACHE_MS;
    expect(await discovery.getInstance('product-service')).toBeNull();
    expect(await instancesGauge(metrics, 'product-service')).toBe(0);
  });

  it('Z13: a refresh from Consul removes series of instances that left the list, evict does not', async () => {
    const consul = mockConsul(() => json(THREE));
    const { discovery, metrics } = createDiscovery();
    const series = async () =>
      (await metrics.registry.getSingleMetric('gateway_upstream_requests_total')!.get()).values.map((value) => value.labels.upstream_instance).sort();
    for (const instance of [await discovery.getInstance('product-service'), await discovery.getInstance('product-service')]) {
      metrics.recordUpstreamAttempt('product-service', instance!.id);
    }
    expect(await series()).toEqual(['stub-1', 'stub-2']);

    discovery.evict('product-service', { id: 'stub-1', address: '10.0.0.1', port: 9000 });
    expect(await series()).toEqual(['stub-1', 'stub-2']);

    consul.set(() => json([entry('stub-2', '10.0.0.2'), entry('stub-3', '10.0.0.3')]));
    now += DISCOVERY_CACHE_MS;
    await discovery.getInstance('product-service');
    expect(await series()).toEqual(['stub-2']);
    expect(await instancesGauge(metrics, 'product-service')).toBe(2);
  });
});
