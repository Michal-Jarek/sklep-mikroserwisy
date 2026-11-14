import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { HTTP_METHODS } from '../config/gateway-config';

// Stage 9b, guidelines 3.1: buckets of the response time histogram, in seconds.
export const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

// Value of the service label when the request has no target service (no configuration, bad path, no route).
export const NO_SERVICE = 'none';

// Values of gateway_circuit_breaker_state.
export const BREAKER_STATE = { closed: 0, halfOpen: 1, open: 2 } as const;
export type BreakerState = (typeof BREAKER_STATE)[keyof typeof BREAKER_STATE];

// Z13: at most this many upstream_instance values per service; attempts to further instances are counted as OTHER_INSTANCE.
export const MAX_UPSTREAM_INSTANCES = 20;
export const OTHER_INSTANCE = 'other';

const METHOD_LABELS = new Set<string>([...HTTP_METHODS, 'OPTIONS']);

/** The method label: one of GET HEAD POST PUT PATCH DELETE OPTIONS, any other method is OTHER (bounded series). */
export function methodLabel(method: string): string {
  return METHOD_LABELS.has(method) ? method : 'OTHER';
}

/**
 * Prometheus metrics of the Gateway (guidelines 3.1) in an own registry, never the global one: tests create many
 * applications, and every series carries gateway_instance (INSTANCE_ID). The label "instance" is left to Prometheus.
 * Labels never hold a path, a query, a user ID, an IP address or a header.
 */
export class GatewayMetrics {
  readonly registry = new Registry();
  private readonly requests: Counter<'service' | 'method' | 'code'>;
  private readonly duration: Histogram<'service' | 'method'>;
  private readonly upstreamRequests: Counter<'service' | 'upstream_instance'>;
  private readonly upstreamInstances: Gauge<'service'>;
  private readonly breakerState: Gauge<'service'>;
  // upstream_instance values with an own series in upstreamRequests, per service (OTHER_INSTANCE not included).
  private readonly trackedInstances = new Map<string, Set<string>>();

  constructor(instanceId: string) {
    this.registry.setDefaultLabels({ gateway_instance: instanceId });
    collectDefaultMetrics({ register: this.registry });
    const registers = [this.registry];
    this.requests = new Counter({
      name: 'gateway_http_requests_total',
      help: 'Responses sent by the Gateway, by target service, method and status code',
      labelNames: ['service', 'method', 'code'],
      registers,
    });
    this.duration = new Histogram({
      name: 'gateway_http_request_duration_seconds',
      help: 'Time from receiving a request to the end of its response',
      labelNames: ['service', 'method'],
      buckets: DURATION_BUCKETS,
      registers,
    });
    this.upstreamRequests = new Counter({
      name: 'gateway_upstream_requests_total',
      help: 'Attempts to send a request to a service instance, also retries on another instance',
      labelNames: ['service', 'upstream_instance'],
      registers,
    });
    this.upstreamInstances = new Gauge({
      name: 'gateway_upstream_instances',
      help: 'Healthy instances of a service known to the Gateway (after a refresh from Consul or an eviction)',
      labelNames: ['service'],
      registers,
    });
    this.breakerState = new Gauge({
      name: 'gateway_circuit_breaker_state',
      help: 'Circuit breaker of a service: 0 closed, 1 half-open, 2 open',
      labelNames: ['service'],
      registers,
    });
  }

  /** One response of the Gateway (onResponse hook). */
  recordResponse(service: string, method: string, statusCode: number, seconds: number): void {
    const label = methodLabel(method);
    this.requests.inc({ service, method: label, code: String(statusCode) });
    this.duration.observe({ service, method: label }, seconds);
  }

  /**
   * One attempt to send a request to an instance (instanceId = ID of the instance in Consul). Z13: up to
   * MAX_UPSTREAM_INSTANCES instances of a service get an own series, attempts to further ones count as OTHER_INSTANCE.
   */
  recordUpstreamAttempt(service: string, instanceId: string): void {
    let tracked = this.trackedInstances.get(service);
    if (!tracked) {
      tracked = new Set();
      this.trackedInstances.set(service, tracked);
    }
    let label = instanceId;
    if (!tracked.has(instanceId)) {
      if (tracked.size < MAX_UPSTREAM_INSTANCES) {
        tracked.add(instanceId);
      } else {
        label = OTHER_INSTANCE;
      }
    }
    this.upstreamRequests.inc({ service, upstream_instance: label });
  }

  /** The instance count after an eviction; the series of the evicted instance stay (it usually returns with the next refresh). */
  setUpstreamInstances(service: string, count: number): void {
    this.upstreamInstances.set({ service }, count);
  }

  /**
   * The list of healthy instances after a refresh from Consul (Z13): sets the instance count and removes the series of
   * instances that are not on the list; the OTHER_INSTANCE series is removed when the list fits in the limit.
   */
  refreshUpstreamInstances(service: string, instanceIds: string[]): void {
    this.upstreamInstances.set({ service }, instanceIds.length);
    const tracked = this.trackedInstances.get(service);
    if (!tracked) {
      return;
    }
    const current = new Set(instanceIds);
    for (const id of tracked) {
      if (!current.has(id)) {
        tracked.delete(id);
        this.upstreamRequests.remove({ service, upstream_instance: id });
      }
    }
    if (current.size <= MAX_UPSTREAM_INSTANCES) {
      this.upstreamRequests.remove({ service, upstream_instance: OTHER_INSTANCE });
    }
  }

  setBreakerState(service: string, state: BreakerState): void {
    this.breakerState.set({ service }, state);
  }
}
