import type { GatewayConfig } from '../config/gateway-config';
import { DURATION_BUCKETS, GatewayMetrics, MAX_UPSTREAM_INSTANCES, methodLabel, NO_SERVICE, OTHER_INSTANCE } from './gateway-metrics';
import { isHealthPath, serviceLabel } from './http-metrics';

// Test data: resource names of the routing table (configuration, not endpoints of the Gateway).
// serviceLabel reads only routes.
const CONFIG = { routes: new Map([['products', 'product-service']]) } as unknown as GatewayConfig;

describe('methodLabel', () => {
  it.each(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('%s keeps its name', (method) => {
    expect(methodLabel(method)).toBe(method);
  });

  it.each(['PROPFIND', 'BREW', 'TRACE', 'QUERY', 'get', ''])('%s -> OTHER', (method) => {
    expect(methodLabel(method)).toBe('OTHER');
  });
});

describe('serviceLabel (guidelines 3.1)', () => {
  it('the route target of the first segment of the canonical path', () => {
    expect(serviceLabel(CONFIG, '/api/v1/products')).toBe('product-service');
    expect(serviceLabel(CONFIG, '/api/v1/products/12/reviews?x=1')).toBe('product-service');
  });

  it('none without configuration', () => {
    expect(serviceLabel(null, '/api/v1/products')).toBe(NO_SERVICE);
  });

  it.each(['/api/v1/products/../x', '/api/v1/products/%2e%2e/x', '/api/v1//products', '/api/v1/products/%zz', '/api/v1/products;x'])(
    'none for a non-canonical path %s',
    (url) => {
      expect(serviceLabel(CONFIG, url)).toBe(NO_SERVICE);
    },
  );

  it.each(['/api/v1/payments', '/api/v1/Products', '/api/v1', '/api/v1?x=1'])('none without a route: %s', (url) => {
    expect(serviceLabel(CONFIG, url)).toBe(NO_SERVICE);
  });

  it.each(['/products', '/metrics', '/', '', '/api/v2/products', '/api/v1products'])('none outside the prefix: "%s"', (url) => {
    expect(serviceLabel(CONFIG, url)).toBe(NO_SERVICE);
  });
});

describe('isHealthPath', () => {
  it.each(['/health', '/health/live', '/health/ready', '/health/ready?x=1', '/health/x/y'])('%s -> not counted', (url) => {
    expect(isHealthPath(url)).toBe(true);
  });

  it.each(['/healthz', '/api/v1/health/ready', '/api/v1/products', '/'])('%s -> counted', (url) => {
    expect(isHealthPath(url)).toBe(false);
  });
});

describe('GatewayMetrics', () => {
  it('has the families of 3.1 and the default metrics, every series with gateway_instance', async () => {
    const metrics = new GatewayMetrics('api-gateway-a1');
    metrics.recordResponse('product-service', 'GET', 200, 0.02);
    metrics.recordUpstreamAttempt('product-service', 'product-service-1');
    metrics.setUpstreamInstances('product-service', 2);
    metrics.setBreakerState('product-service', 2);
    const text = await metrics.registry.metrics();

    for (const type of [
      'gateway_http_requests_total counter',
      'gateway_http_request_duration_seconds histogram',
      'gateway_upstream_requests_total counter',
      'gateway_upstream_instances gauge',
      'gateway_circuit_breaker_state gauge',
      'process_resident_memory_bytes gauge',
      'nodejs_eventloop_lag_seconds gauge',
    ]) {
      expect(text).toContain(`# TYPE ${type}\n`);
    }
    expect(text).toContain('gateway_http_requests_total{service="product-service",method="GET",code="200",gateway_instance="api-gateway-a1"} 1\n');
    expect(text).toContain('gateway_upstream_requests_total{service="product-service",upstream_instance="product-service-1",gateway_instance="api-gateway-a1"} 1\n');
    expect(text).toContain('gateway_upstream_instances{service="product-service",gateway_instance="api-gateway-a1"} 2\n');
    expect(text).toContain('gateway_circuit_breaker_state{service="product-service",gateway_instance="api-gateway-a1"} 2\n');
    const series = text.split('\n').filter((line) => line !== '' && !line.startsWith('#'));
    expect(series.length).toBeGreaterThan(20);
    expect(series.filter((line) => !line.includes('gateway_instance="api-gateway-a1"'))).toEqual([]);
    // "instance" is the label of Prometheus itself.
    expect(text).not.toMatch(/[{,]instance="/);
  });

  it('histogram buckets of 3.1', async () => {
    expect(DURATION_BUCKETS).toEqual([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);
    const metrics = new GatewayMetrics('a');
    metrics.recordResponse('none', 'BREW', 404, 0.03);
    const text = await metrics.registry.metrics();
    // prom-client 15.1.3 writes le first, then the default label, then the own labels.
    const buckets = [...text.matchAll(/gateway_http_request_duration_seconds_bucket\{le="([^"]+)",gateway_instance="a",service="none",method="OTHER"\} (\d+)/g)];
    expect(buckets.map((match) => match[1])).toEqual([...DURATION_BUCKETS.map(String), '+Inf']);
    expect(buckets.map((match) => Number(match[2]))).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('two instances have separate registries (no "already registered" error, no shared values)', async () => {
    const first = new GatewayMetrics('a');
    const second = new GatewayMetrics('b');
    first.recordResponse('none', 'GET', 404, 0.001);
    expect(await first.registry.metrics()).toContain('gateway_http_requests_total{service="none",method="GET",code="404",gateway_instance="a"} 1');
    expect(await second.registry.metrics()).not.toContain('gateway_http_requests_total{');
  });
});

/** Values of gateway_upstream_requests_total of the service by upstream_instance. */
async function upstreamSeries(metrics: GatewayMetrics, service: string): Promise<Record<string, number>> {
  const metric = await metrics.registry.getSingleMetric('gateway_upstream_requests_total')!.get();
  return Object.fromEntries(
    metric.values.filter((value) => value.labels.service === service).map((value) => [String(value.labels.upstream_instance), value.value]),
  );
}

const instanceIds = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `product-${from + i}`);

describe('GatewayMetrics: bounded series of gateway_upstream_requests_total (Z13)', () => {
  it('the limit is 20 instances per service, further ones are "other"', () => {
    expect(MAX_UPSTREAM_INSTANCES).toBe(20);
    expect(OTHER_INSTANCE).toBe('other');
  });

  it('the 21st and further instances are counted as "other" (20 + other), known instances keep their series', async () => {
    const metrics = new GatewayMetrics('a');
    for (const id of instanceIds(1, 30)) {
      metrics.recordUpstreamAttempt('product-service', id);
    }
    metrics.recordUpstreamAttempt('product-service', 'product-1');
    metrics.recordUpstreamAttempt('product-service', 'product-25');
    const series = await upstreamSeries(metrics, 'product-service');
    expect(Object.keys(series)).toHaveLength(21);
    expect(series).toMatchObject({ 'product-1': 2, 'product-20': 1, other: 11 });
    expect(series['product-21']).toBeUndefined();
    // The limit is per service.
    metrics.recordUpstreamAttempt('cart-service', 'cart-1');
    expect(await upstreamSeries(metrics, 'cart-service')).toEqual({ 'cart-1': 1 });
  });

  it('a refresh removes the series of instances that are not on the new list and sets the gauge', async () => {
    const metrics = new GatewayMetrics('a');
    for (const id of ['product-1', 'product-2', 'product-3']) {
      metrics.recordUpstreamAttempt('product-service', id);
    }
    metrics.recordUpstreamAttempt('cart-service', 'product-2');
    metrics.refreshUpstreamInstances('product-service', ['product-1', 'product-4']);
    expect(await upstreamSeries(metrics, 'product-service')).toEqual({ 'product-1': 1 });
    // Series of another service with the same ID stay.
    expect(await upstreamSeries(metrics, 'cart-service')).toEqual({ 'product-2': 1 });
    expect(await metrics.registry.metrics()).toContain('gateway_upstream_instances{service="product-service",gateway_instance="a"} 2\n');
  });

  it('setUpstreamInstances (evict) sets only the gauge, the series stay', async () => {
    const metrics = new GatewayMetrics('a');
    metrics.recordUpstreamAttempt('product-service', 'product-1');
    metrics.setUpstreamInstances('product-service', 0);
    expect(await upstreamSeries(metrics, 'product-service')).toEqual({ 'product-1': 1 });
  });

  it('"other" stays while the list has more than 20 instances and is removed by a refresh to <= 20', async () => {
    const metrics = new GatewayMetrics('a');
    for (const id of instanceIds(1, 31)) {
      metrics.recordUpstreamAttempt('product-service', id);
    }
    metrics.refreshUpstreamInstances('product-service', instanceIds(1, 31));
    expect(Object.keys(await upstreamSeries(metrics, 'product-service'))).toHaveLength(21);

    metrics.refreshUpstreamInstances('product-service', instanceIds(1, 20));
    const series = await upstreamSeries(metrics, 'product-service');
    expect(Object.keys(series).sort()).toEqual(instanceIds(1, 20).sort());
    expect(series.other).toBeUndefined();
  });

  it('a removed instance that appears again is counted from the start, and frees a place under the limit', async () => {
    const metrics = new GatewayMetrics('a');
    for (const id of instanceIds(1, 20)) {
      metrics.recordUpstreamAttempt('product-service', id);
    }
    metrics.recordUpstreamAttempt('product-service', 'product-1');
    metrics.refreshUpstreamInstances('product-service', instanceIds(2, 21));
    metrics.recordUpstreamAttempt('product-service', 'product-21');
    expect((await upstreamSeries(metrics, 'product-service'))['product-21']).toBe(1);

    metrics.refreshUpstreamInstances('product-service', instanceIds(1, 20));
    metrics.recordUpstreamAttempt('product-service', 'product-1');
    const series = await upstreamSeries(metrics, 'product-service');
    expect(series['product-1']).toBe(1);
    expect(series['product-21']).toBeUndefined();
    expect(Object.keys(series)).toHaveLength(20);
  });
});
