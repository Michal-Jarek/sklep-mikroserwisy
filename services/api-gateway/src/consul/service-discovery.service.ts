import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { GatewayMetrics } from '../metrics/gateway-metrics';
import { consulHealthyInstancesPath } from '../routes';
import { consulFetch, consulStatusError, describeError } from './consul-http';

// How long the list of healthy instances of one service is reused (also after a failed refresh).
export const DISCOVERY_CACHE_MS = 10_000;
// An empty list is reused only briefly (Z20): a service that starts after the Gateway is reachable within seconds.
export const DISCOVERY_EMPTY_CACHE_MS = 2_000;
// After a restart Consul restores registrations from its data directory but lists an instance as passing only after
// its check has run again (1-2 s, at most the check interval), so for a moment it answers "no healthy instance" for
// services that are up (Z6). An empty answer after a non-empty list is therefore not trusted at once: the last known
// list is used (Consul asked every 2 s) until Consul has kept answering "empty" for this long. Counted from the first
// empty answer of the series; a non-empty answer or a Consul error ends the series (an outage does not age the list).
export const DISCOVERY_EMPTY_GRACE_MS = 30_000;

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
  // First empty answer of the current series while the last known list is used (DISCOVERY_EMPTY_GRACE_MS).
  emptySince?: number;
  // Set with the warning on entering the last-known-list mode, cleared with the info at the first non-empty answer
  // (CR-37): also when the series ended by evict, by the 30 s limit or by a Consul error in between.
  lastListMode?: boolean;
}

/**
 * Turns the /v1/health/service response into instances sorted by id; entries without id, address or port are skipped.
 * Only entries named exactly serviceName are kept: Consul matches the name in the path without case, while ACL compares
 * it exactly, so "AUTH-SERVICE" registered without a token would otherwise get the traffic of "auth-service".
 */
export function parseHealthyInstances(body: unknown, serviceName: string): Instance[] {
  if (!Array.isArray(body)) {
    throw new Error('Unexpected response from Consul health API');
  }
  const instances: Instance[] = [];
  for (const entry of body as unknown[]) {
    const item = entry as {
      Service?: { ID?: unknown; Service?: unknown; Address?: unknown; Port?: unknown };
      Node?: { Address?: unknown };
    } | null;
    if (item?.Service?.Service !== serviceName) {
      continue;
    }
    const id = item.Service.ID;
    const serviceAddress = item.Service.Address;
    // Consul uses the node address when the service was registered without one.
    const address = typeof serviceAddress === 'string' && serviceAddress ? serviceAddress : item.Node?.Address;
    const port = item.Service.Port;
    if (typeof id === 'string' && id && typeof address === 'string' && address && typeof port === 'number' && port > 0) {
      instances.push({ id, address, port });
    }
  }
  return instances.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Healthy instances of the services behind the Gateway (decision 6): one request to Consul per
 * service at a time, list cached for 10 s (an empty one for 2 s), round robin per service. When Consul fails, the last
 * known list is used and Consul is asked again after 10 s (one warning per change of state). An empty answer after a
 * non-empty list keeps the last known list for at most 30 s (DISCOVERY_EMPTY_GRACE_MS).
 */
@Injectable()
export class ServiceDiscovery {
  private readonly cache = new Map<string, CacheEntry>();
  private consulFailing = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectPinoLogger(ServiceDiscovery.name) private readonly logger: PinoLogger,
    private readonly metrics: GatewayMetrics,
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
      this.metrics.setUpstreamInstances(serviceName, entry.instances.length);
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
        throw consulStatusError('Consul', response.status);
      }
      const instances = parseHealthyInstances(await response.json(), serviceName);
      const graceMs = instances.length === 0 ? this.emptyGraceLeft(serviceName, entry) : 0;
      if (graceMs > 0) {
        // The last known list stays (metrics too); Consul is asked again within 2 s.
        cacheMs = Math.min(DISCOVERY_EMPTY_CACHE_MS, graceMs);
      } else {
        if (instances.length > 0 && entry.lastListMode) {
          entry.lastListMode = false;
          this.logger.info({ targetService: serviceName }, 'Consul lists healthy instances again');
        }
        entry.emptySince = undefined;
        entry.instances = instances;
        this.metrics.refreshUpstreamInstances(
          serviceName,
          instances.map((instance) => instance.id),
        );
        if (instances.length === 0) {
          cacheMs = DISCOVERY_EMPTY_CACHE_MS;
        }
      }
      if (this.consulFailing) {
        this.consulFailing = false;
        this.logger.info({ targetService: serviceName }, 'Consul service discovery works again');
      }
    } catch (error) {
      entry.emptySince = undefined;
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

  /**
   * Consul answered with no healthy instance. Returns how long the last known list may still be used (> 0), or 0 when
   * there is no non-empty list in memory (start, list emptied by evict) or the series of empty answers lasted 30 s.
   */
  private emptyGraceLeft(serviceName: string, entry: CacheEntry): number {
    if (!entry.instances || entry.instances.length === 0) {
      return 0;
    }
    const now = Date.now();
    entry.emptySince ??= now;
    if (!entry.lastListMode) {
      entry.lastListMode = true;
      this.logger.warn({ targetService: serviceName }, 'Consul lists no healthy instance, using the last known list');
    }
    const left = entry.emptySince + DISCOVERY_EMPTY_GRACE_MS - now;
    if (left <= 0) {
      this.logger.warn({ targetService: serviceName }, 'Consul still lists no healthy instance, last known list dropped');
    }
    return Math.max(left, 0);
  }
}
