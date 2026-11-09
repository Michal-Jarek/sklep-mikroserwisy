import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig, SERVICE_NAME } from '../config/app-config';
import { CONSUL_REGISTER_PATH, consulDeregisterPath, consulServicePath, PATHS } from '../routes';
import { consulFetch, describeError } from './consul-http';
import { LoopbackAddressError, localAddressTowards, resolveServiceAddress, type RouteAddressFn } from './service-address';

// How often the Gateway checks that it is still registered (e.g. after a Consul restart).
export const REGISTRATION_CHECK_MS = 15_000;

/**
 * Registers this instance in the local Consul agent, re-registers it when the registration
 * disappears or is outdated (Consul restarted, was down at startup, kept an old address) and
 * deregisters it on shutdown (SIGTERM).
 */
@Injectable()
export class ConsulRegistration implements OnApplicationShutdown {
  // Replaced in unit tests.
  routeAddress: RouteAddressFn = localAddressTowards;
  private timer?: NodeJS.Timeout;
  private consulReachable = true;
  private running = false;
  private address = '';
  private isReady: () => Promise<boolean> = () => Promise.resolve(false);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectPinoLogger(ConsulRegistration.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Called after the HTTP server listens. `isReady` is the readiness of the Gateway (configuration loaded).
   * Throws LoopbackAddressError (startup error); an unresolvable CONSUL_HOST is retried every 15 s.
   */
  async start(isReady: () => Promise<boolean>): Promise<void> {
    this.isReady = isReady;
    try {
      this.address = await this.resolveAddress();
    } catch (error) {
      if (error instanceof LoopbackAddressError) {
        throw error;
      }
      // Consul not resolvable yet: ensureRegistered() logs it once and retries.
    }
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
        // so the current readiness is given as the initial status.
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
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      if (!this.address) {
        this.address = await this.resolveAddress();
      }
      if (!(await this.isRegistered())) {
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
    } finally {
      this.running = false;
    }
  }

  private resolveAddress(): Promise<string> {
    return resolveServiceAddress(this.config.consul.serviceAddress, this.config.consul, this.routeAddress);
  }

  private async isRegistered(): Promise<boolean> {
    const response = await consulFetch(this.config.consul, consulServicePath(this.config.instanceId));
    if (response.status === 404) {
      return false;
    }
    if (!response.ok) {
      throw new Error(`Consul responded with ${response.status}`);
    }
    // Consul keeps registrations in its data directory. After a container restart the same ID
    // (same hostname) can point to the old IP address, so the entry must match the current one.
    const service = (await response.json()) as { Address?: unknown; Port?: unknown };
    return service.Address === this.address && service.Port === this.config.port;
  }

  private async register(): Promise<void> {
    const status = (await this.isReady()) ? 'passing' : 'critical';
    const response = await consulFetch(this.config.consul, CONSUL_REGISTER_PATH, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.registrationBody(status)),
    });
    if (!response.ok) {
      throw new Error(`Consul registration responded with ${response.status}`);
    }
    this.logger.info({ instanceId: this.config.instanceId, address: this.address, status }, 'Registered in Consul');
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    try {
      const response = await consulFetch(this.config.consul, consulDeregisterPath(this.config.instanceId), {
        method: 'PUT',
      });
      if (!response.ok) {
        throw new Error(`Consul deregistration responded with ${response.status}`);
      }
      this.logger.info({ instanceId: this.config.instanceId }, 'Deregistered from Consul');
    } catch (error) {
      this.logger.warn({ reason: describeError(error) }, 'Deregistration from Consul failed');
    }
  }
}
