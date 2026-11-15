import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { networkInterfaces } from 'node:os';
import { APP_CONFIG, type AppConfig, SERVICE_NAME } from '../config/app-config';
import {
  CONSUL_REGISTER_PATH,
  consulDeregisterPath,
  consulServiceInstancesPath,
  consulServicePath,
  PATHS,
} from '../routes';
import { consulFetch, consulStatusError, describeError } from './consul-http';

// How often the service checks that it is still registered (e.g. after a Consul restart).
export const REGISTRATION_CHECK_MS = 15_000;

type Interfaces = ReturnType<typeof networkInterfaces>;

/** SERVICE_ADDRESS when set, otherwise the first non-loopback IPv4 address of the container. */
export function resolveServiceAddress(configured: string, interfaces: Interfaces = networkInterfaces()): string {
  if (configured) {
    return configured;
  }
  for (const addresses of Object.values(interfaces)) {
    const ipv4 = addresses?.find((address) => address.family === 'IPv4' && !address.internal);
    if (ipv4) {
      return ipv4.address;
    }
  }
  throw new Error('No non-loopback IPv4 address found, set SERVICE_ADDRESS');
}

/** Fields of GET /v1/agent/service/<id> (and of Service in /v1/health/service/<name>) used here. */
interface ConsulEntry {
  ID?: unknown;
  Service?: unknown;
  Address?: unknown;
  Port?: unknown;
}

/**
 * Registers this instance in the local Consul agent (replacing an entry of the previous process with
 * the same ID), re-registers it when the registration disappears (Consul restarted or was down at
 * startup) and deregisters it on shutdown (SIGTERM).
 */
@Injectable()
export class ConsulRegistration implements OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private consulReachable = true;
  // False until the first successful registration of this process.
  private registered = false;
  private address = '';
  private isReady: () => Promise<boolean> = () => Promise.resolve(false);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectPinoLogger(ConsulRegistration.name) private readonly logger: PinoLogger,
  ) {}

  /** Called after the HTTP server listens. `isReady` is the readiness check of the service (SELECT 1). */
  async start(isReady: () => Promise<boolean>): Promise<void> {
    if (!this.config.consul.enabled) {
      this.logger.info('Consul disabled (CONSUL_ENABLED=false), the service is not registered');
      return;
    }
    this.address = resolveServiceAddress(this.config.consul.serviceAddress);
    this.isReady = isReady;
    await this.ensureRegistered();
    this.timer = setInterval(() => void this.ensureRegistered(), REGISTRATION_CHECK_MS);
    this.timer.unref();
  }

  registrationBody(status: 'passing' | 'critical'): object {
    const { instanceId, port } = this.config;
    return {
      ID: instanceId,
      Name: SERVICE_NAME,
      Address: this.address,
      Port: port,
      Check: {
        // Consul starts a new check as critical and runs it only within one interval (up to 10 s),
        // so the current result of our own readiness check is given as the initial status.
        Status: status,
        HTTP: `http://${this.address}:${port}${PATHS.healthReady}`,
        Interval: '10s',
        Timeout: '2s',
        DeregisterCriticalServiceAfter: '1m',
      },
    };
  }

  /** Registers the instance when Consul does not know it (or knows an outdated entry). Never throws. */
  async ensureRegistered(): Promise<void> {
    try {
      const entry = await this.currentEntry();
      if (!this.registered) {
        await this.registerAtStart(entry);
      } else if (!this.matches(entry)) {
        await this.register();
      }
      if (!this.consulReachable) {
        this.consulReachable = true;
        this.logger.info('Consul is reachable again');
      }
    } catch (error) {
      // One warning per change of state, so a long Consul outage does not flood the logs.
      if (this.consulReachable) {
        this.consulReachable = false;
        this.logger.warn({ reason: describeError(error) }, 'Consul is not reachable, will retry the registration');
      }
    }
  }

  /** The entry of this ID in Consul, or null when Consul does not know it (404). */
  private async currentEntry(): Promise<ConsulEntry | null> {
    const response = await consulFetch(this.config.consul, consulServicePath(this.config.instanceId));
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw consulStatusError('Consul', response.status);
    }
    return (await response.json()) as ConsulEntry;
  }

  // Consul keeps registrations in its data directory. After a container restart the same ID
  // (same hostname) can point to the old IP address, so the entry must match the current one.
  private matches(entry: ConsulEntry | null): boolean {
    return entry !== null && entry.Address === this.address && entry.Port === this.config.port;
  }

  /**
   * First registration of this process. An entry with the same ID can be left by the previous process
   * killed without deregistration (Docker Compose: the same container started again keeps its hostname).
   * Consul keeps the state of an existing check (e.g. critical from the outage) on a new registration and
   * ignores "Status", so such an entry is removed first. In Kubernetes the ID is the pod name: after a
   * container restart in the same pod the entry has the same address, which consul-guard accepts.
   */
  private async registerAtStart(entry: ConsulEntry | null): Promise<void> {
    await this.removeOrphans();
    if (entry !== null) {
      await this.deregister(this.config.instanceId);
      this.logger.info({ instanceId: this.config.instanceId }, 'Removed the entry of the previous process from Consul');
    }
    await this.register();
    this.registered = true;
  }

  /**
   * Z7: entries of this service with the address and port of this instance but another ID were left by a previous
   * container killed without deregistration (Docker Compose: a new container gets a new hostname = new ID and often
   * the same IP address). Consul would keep them until DeregisterCriticalServiceAfter. An invalid answer (HTTP not 2xx,
   * invalid JSON, a refused deregistration) is one warning and the registration goes on: the cleanup never blocks the
   * start. A transport error
   * (Consul not reachable, timeout) ends the whole attempt like a failed registration; it is repeated with the next one.
   */
  private async removeOrphans(): Promise<void> {
    const response = await consulFetch(this.config.consul, consulServiceInstancesPath(SERVICE_NAME));
    let orphans: string[];
    try {
      orphans = await this.orphanIds(response);
    } catch (error) {
      this.logger.warn({ reason: describeError(error) }, 'Cleanup of orphaned Consul entries failed, registering anyway');
      return;
    }
    // A refused deregistration of one orphan does not stop the others (CR-34): counted, one warning after the loop.
    let failed = 0;
    let lastStatus = 0;
    for (const orphan of orphans) {
      const removed = await consulFetch(this.config.consul, consulDeregisterPath(orphan), { method: 'PUT' });
      if (!removed.ok) {
        failed += 1;
        lastStatus = removed.status;
        continue;
      }
      this.logger.info({ instanceId: orphan }, 'Removed an orphaned entry with the address of this instance from Consul');
    }
    if (failed > 0) {
      this.logger.warn(
        { failed, reason: describeError(consulStatusError('Consul deregistration', lastStatus)) },
        'Cleanup of orphaned Consul entries failed, registering anyway',
      );
    }
  }

  /** IDs of the entries of this service with the address and port of this instance and another ID. */
  private async orphanIds(response: Response): Promise<string[]> {
    if (!response.ok) {
      throw consulStatusError('Consul', response.status);
    }
    const body = (await response.json()) as unknown;
    if (!Array.isArray(body)) {
      throw new Error('Unexpected response from Consul health API');
    }
    const orphans: string[] = [];
    for (const item of body as unknown[]) {
      const service = (item as { Service?: ConsulEntry } | null)?.Service;
      if (
        typeof service?.ID === 'string' &&
        service.ID !== this.config.instanceId &&
        service.Service === SERVICE_NAME &&
        service.Address === this.address &&
        service.Port === this.config.port
      ) {
        orphans.push(service.ID);
      }
    }
    return orphans;
  }

  private async deregister(instanceId: string): Promise<void> {
    const response = await consulFetch(this.config.consul, consulDeregisterPath(instanceId), {
      method: 'PUT',
    });
    if (!response.ok) {
      throw consulStatusError('Consul deregistration', response.status);
    }
  }

  private async register(): Promise<void> {
    const status = (await this.isReady()) ? 'passing' : 'critical';
    const response = await consulFetch(this.config.consul, CONSUL_REGISTER_PATH, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.registrationBody(status)),
    });
    if (!response.ok) {
      throw consulStatusError('Consul registration', response.status);
    }
    this.logger.info({ instanceId: this.config.instanceId, address: this.address, status }, 'Registered in Consul');
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    if (!this.config.consul.enabled) {
      return;
    }
    try {
      await this.deregister(this.config.instanceId);
      this.logger.info({ instanceId: this.config.instanceId }, 'Deregistered from Consul');
    } catch (error) {
      this.logger.warn({ reason: describeError(error) }, 'Deregistration from Consul failed');
    }
  }
}
