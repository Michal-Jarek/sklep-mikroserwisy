import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { consulHealthyInstancesPath } from '../routes';
import { consulFetch, consulStatusError, describeError } from './consul-http';

// How long the list of healthy instances of one service is reused.
export const DISCOVERY_CACHE_MS = 10_000;

interface CachedInstances {
  urls: string[];
  expiresAt: number;
}

/**
 * Turns the /v1/health/service response into base URLs; entries without an address or port are skipped.
 * Only entries named exactly serviceName are kept: Consul matches the name in the path without case, while ACL compares
 * it exactly, so "USER-SERVICE" registered without a token would otherwise get the calls meant for "user-service".
 */
export function parseHealthyInstances(body: unknown, serviceName: string): string[] {
  if (!Array.isArray(body)) {
    throw new Error('Unexpected response from Consul health API');
  }
  const urls: string[] = [];
  for (const entry of body as unknown[]) {
    const item = entry as { Service?: { Service?: unknown; Address?: unknown; Port?: unknown }; Node?: { Address?: unknown } } | null;
    if (item?.Service?.Service !== serviceName) {
      continue;
    }
    const serviceAddress = item.Service.Address;
    // Consul uses the node address when the service was registered without one.
    const address = typeof serviceAddress === 'string' && serviceAddress ? serviceAddress : item.Node?.Address;
    const port = item.Service.Port;
    if (typeof address === 'string' && address && typeof port === 'number' && port > 0) {
      urls.push(`http://${address}:${port}`);
    }
  }
  return urls;
}

/**
 * Finds a healthy instance of another service in Consul (passing checks only).
 * The list is cached for 10 s, instances are used in turn (round robin); an instance without a connection
 * is evicted from the list (evict).
 */
@Injectable()
export class ServiceDiscovery {
  private readonly cache = new Map<string, CachedInstances>();
  private readonly nextIndex = new Map<string, number>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectPinoLogger(ServiceDiscovery.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Returns a base URL such as "http://10.1.2.3:8082", or null when there is no healthy
   * instance, Consul is unavailable or disabled. The caller turns null into 503 SERVICE_UNAVAILABLE.
   */
  async getInstance(serviceName: string): Promise<string | null> {
    const urls = await this.healthyInstances(serviceName);
    if (urls.length === 0) {
      return null;
    }
    const index = this.nextIndex.get(serviceName) ?? 0;
    this.nextIndex.set(serviceName, index + 1);
    return urls[index % urls.length];
  }

  /**
   * Drops an instance from the cached list until the next refresh from Consul (e.g. the connection failed, D13).
   * When no instance is left, the next call asks Consul again instead of reusing an empty list for 10 s.
   */
  evict(serviceName: string, baseUrl: string): void {
    const cached = this.cache.get(serviceName);
    if (!cached) {
      return;
    }
    cached.urls = cached.urls.filter((url) => url !== baseUrl);
    if (cached.urls.length === 0) {
      this.cache.delete(serviceName);
    }
  }

  private async healthyInstances(serviceName: string): Promise<string[]> {
    if (!this.config.consul.enabled) {
      return [];
    }
    const cached = this.cache.get(serviceName);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.urls;
    }
    try {
      const response = await consulFetch(this.config.consul, consulHealthyInstancesPath(serviceName));
      if (!response.ok) {
        throw consulStatusError('Consul', response.status);
      }
      const urls = parseHealthyInstances(await response.json(), serviceName);
      this.cache.set(serviceName, { urls, expiresAt: Date.now() + DISCOVERY_CACHE_MS });
      return urls;
    } catch (error) {
      this.logger.warn({ targetService: serviceName, reason: describeError(error) }, 'Service discovery in Consul failed');
      return [];
    }
  }
}
