import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { consulFetch, consulStatusError, describeError } from '../consul/consul-http';
import { consulKvRawPath } from '../routes';
import { APP_CONFIG, type AppConfig, SERVICE_NAME } from './app-config';
import { ConfigValidationError, type GatewayConfig, parseGatewayConfig } from './gateway-config';

export const KV_KEY = `config/${SERVICE_NAME}/data`;

// How often a failed read of the KV document is retried.
export const CONFIG_RETRY_MS = 15_000;

interface Failure {
  level: 'warn' | 'error';
  fields: Record<string, unknown>;
  message: string;
}

/**
 * Configuration from Consul KV. The Gateway listens before it is loaded: current() is null until
 * the first successful read (then /health/ready and every proxied request answer 503). A failed
 * read (Consul down, no key, bad YAML, broken rule) is logged once per change of state and retried
 * every 15 s. Once loaded, the configuration stays the same until a restart.
 */
@Injectable()
export class GatewayConfigState implements OnApplicationShutdown {
  private config: GatewayConfig | null = null;
  private timer?: NodeJS.Timeout;
  private lastFailure?: string;
  private onLoaded: (config: GatewayConfig) => void = () => undefined;

  constructor(
    @Inject(APP_CONFIG) private readonly appConfig: AppConfig,
    @InjectPinoLogger(GatewayConfigState.name) private readonly logger: PinoLogger,
  ) {}

  /** The loaded configuration, or null while it is not loaded yet. */
  current(): GatewayConfig | null {
    return this.config;
  }

  /** First read now (at most ~2 s, never throws), then retries until it succeeds. */
  async start(onLoaded: (config: GatewayConfig) => void = () => undefined): Promise<void> {
    this.onLoaded = onLoaded;
    await this.attempt();
  }

  private async attempt(): Promise<void> {
    const result = await this.read();
    if ('failure' in result) {
      this.report(result.failure);
      this.timer = setTimeout(() => void this.attempt(), CONFIG_RETRY_MS);
      this.timer.unref();
      return;
    }
    this.config = result.config;
    this.logger.info(
      { key: KV_KEY, routes: result.config.routes.size, accessRules: result.config.access.length },
      'Gateway configuration loaded',
    );
    this.onLoaded(result.config);
  }

  private async read(): Promise<{ config: GatewayConfig } | { failure: Failure }> {
    let response: Response;
    try {
      response = await consulFetch(this.appConfig.consul, consulKvRawPath(KV_KEY));
    } catch (error) {
      return {
        failure: {
          level: 'warn',
          fields: { reason: describeError(error) },
          message: 'Consul is not reachable, gateway configuration not loaded yet',
        },
      };
    }
    if (!response.ok) {
      return {
        failure: {
          level: 'warn',
          fields: { status: response.status, key: KV_KEY, reason: consulStatusError('Consul KV', response.status).message },
          message: 'Consul KV key not available, gateway configuration not loaded yet',
        },
      };
    }
    try {
      return { config: parseGatewayConfig(await response.text(), this.appConfig.overrides) };
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        // The field is in the message itself (e.g. "access[0].access must be one of ..."), never the document.
        return { failure: { level: 'error', fields: { key: KV_KEY }, message: `Invalid gateway configuration: ${error.message}` } };
      }
      return {
        failure: {
          level: 'error',
          fields: { key: KV_KEY, reason: describeError(error) },
          message: 'Invalid YAML in gateway configuration',
        },
      };
    }
  }

  /** One log line per change of state, so a long outage does not flood the logs. */
  private report(failure: Failure): void {
    // The kind of failure is the state; a different reason of the same kind (e.g. DNS error vs timeout) is not a change.
    if (failure.message === this.lastFailure) {
      return;
    }
    this.lastFailure = failure.message;
    this.logger[failure.level]({ ...failure.fields, retryInSeconds: CONFIG_RETRY_MS / 1000 }, failure.message);
  }

  onApplicationShutdown(): void {
    clearTimeout(this.timer);
  }
}
