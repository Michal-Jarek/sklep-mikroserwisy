import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { consulHealthyInstancesPath } from '../routes';
import { consulFetch, describeError } from './consul-http';

// How long the list of healthy instances of one service is reused.
export const DISCOVERY_CACHE_MS = 10_000;

interface CachedInstances {
  urls: string[];
  expiresAt: number;
}

/** Turns the /v1/health/service response into base URLs; entries without an address or port are skipped. */
export function parseHealthyInstances(body: unknown): string[] {
  if (!Array.isArray(body)) {
    throw new Error('Unexpected response from Consul health API');
  }
  const urls: string[] = [];
  for (const entry of body as unknown[]) {
    const item = entry as { Service?: { Address?: unknown; Port?: unknown }; Node?: { Address?: unknown } } | null;
    const serviceAddress = item?.Service?.Address;
    // Consul uses the node address when the service was registered without one.
    const address = typeof serviceAddress === 'string' && serviceAddress ? serviceAddress : item?.Node?.Address;
    const port = item?.Service?.Port;
    if (typeof address === 'string' && address && typeof port === 'number' && port > 0) {
      urls.push(`http://${address}:${port}`);
    }
  }
  return urls;
}

/**
 * Finds a healthy instance of another service in Consul (passing checks only).
 * The list is cached for 10 s, instances are used in turn (round robin).
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
        throw new Error(`Consul responded with ${response.status}`);
      }
      const urls = parseHealthyInstances(await response.json());
      this.cache.set(serviceName, { urls, expiresAt: Date.now() + DISCOVERY_CACHE_MS });
      return urls;
    } catch (error) {
      this.logger.warn({ targetService: serviceName, reason: describeError(error) }, 'Service discovery in Consul failed');
      return [];
    }
  }
}
