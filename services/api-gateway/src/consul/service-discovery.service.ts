import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { consulHealthyInstancesPath } from '../routes';
import { consulFetch, describeError } from './consul-http';

// How long the list of healthy instances of one service is reused (also after a failed refresh).
export const DISCOVERY_CACHE_MS = 10_000;
// An empty list is reused only briefly (Z20): a service that starts after the Gateway is reachable within seconds.
export const DISCOVERY_EMPTY_CACHE_MS = 2_000;

/** One healthy instance of a service from Consul. */
export interface Instance {
  id: string;
  address: string;
  port: number;
}

interface CacheEntry {
  // Last known list (sorted by id); null until the first successful answer from Consul.
  instances: Instance[] | null;
  refreshAt: number;
  // The refresh in progress: concurrent callers wait for the same request to Consul.
  pending?: Promise<void>;
  // Round robin counter, kept across refreshes.
  next: number;
}

/** Turns the /v1/health/service response into instances sorted by id; entries without id, address or port are skipped. */
export function parseHealthyInstances(body: unknown): Instance[] {
  if (!Array.isArray(body)) {
    throw new Error('Unexpected response from Consul health API');
  }
  const instances: Instance[] = [];
  for (const entry of body as unknown[]) {
    const item = entry as { Service?: { ID?: unknown; Address?: unknown; Port?: unknown }; Node?: { Address?: unknown } } | null;
    const id = item?.Service?.ID;
    const serviceAddress = item?.Service?.Address;
    // Consul uses the node address when the service was registered without one.
    const address = typeof serviceAddress === 'string' && serviceAddress ? serviceAddress : item?.Node?.Address;
    const port = item?.Service?.Port;
    if (typeof id === 'string' && id && typeof address === 'string' && address && typeof port === 'number' && port > 0) {
      instances.push({ id, address, port });
    }
  }
  return instances.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Healthy instances of the services behind the Gateway (decision 6): one request to Consul per
 * service at a time, list cached for 10 s (an empty one for 2 s), round robin per service. When Consul fails, the last
 * known list is used and Consul is asked again after 10 s (one warning per change of state).
 */
@Injectable()
export class ServiceDiscovery {
  private readonly cache = new Map<string, CacheEntry>();
  private consulFailing = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectPinoLogger(ServiceDiscovery.name) private readonly logger: PinoLogger,
  ) {}

  /** Next instance of the service (round robin), or null when there is no healthy instance (-> 503). */
  async getInstance(serviceName: string): Promise<Instance | null> {
    let entry = this.cache.get(serviceName);
    if (!entry) {
      entry = { instances: null, refreshAt: 0, next: 0 };
      this.cache.set(serviceName, entry);
    }
    if (Date.now() >= entry.refreshAt) {
      await this.refresh(serviceName, entry);
    }
    const instances = entry.instances;
    if (!instances || instances.length === 0) {
      return null;
    }
    const instance = instances[entry.next % instances.length];
    entry.next += 1;
    return instance;
  }

  /**
   * Drops an instance from the cached list until the next refresh from Consul (e.g. the connection failed).
   * A list emptied this way is refreshed within 2 s, like an empty list from Consul (Z22): a service with one
   * instance is not unavailable for 10 s after one failed connection.
   */
  evict(serviceName: string, instance: Instance): void {
    const entry = this.cache.get(serviceName);
    if (entry?.instances) {
      entry.instances = entry.instances.filter((item) => item.id !== instance.id);
      if (entry.instances.length === 0) {
        entry.refreshAt = Math.min(entry.refreshAt, Date.now() + DISCOVERY_EMPTY_CACHE_MS);
      }
    }
  }

  private refresh(serviceName: string, entry: CacheEntry): Promise<void> {
    entry.pending ??= this.fetchInstances(serviceName, entry).finally(() => {
      entry.pending = undefined;
    });
    return entry.pending;
  }

  private async fetchInstances(serviceName: string, entry: CacheEntry): Promise<void> {
    let cacheMs = DISCOVERY_CACHE_MS;
    try {
      const response = await consulFetch(this.config.consul, consulHealthyInstancesPath(serviceName));
      if (!response.ok) {
        throw new Error(`Consul responded with ${response.status}`);
      }
      entry.instances = parseHealthyInstances(await response.json());
      if (entry.instances.length === 0) {
        cacheMs = DISCOVERY_EMPTY_CACHE_MS;
      }
      if (this.consulFailing) {
        this.consulFailing = false;
        this.logger.info({ targetService: serviceName }, 'Consul service discovery works again');
      }
    } catch (error) {
      if (!this.consulFailing) {
        this.consulFailing = true;
        this.logger.warn(
          { targetService: serviceName, reason: describeError(error) },
          'Consul service discovery failed, using the last known instances',
        );
      }
    } finally {
      entry.refreshAt = Date.now() + cacheMs;
    }
  }
}
