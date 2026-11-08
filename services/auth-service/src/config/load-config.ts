import type { Logger } from 'pino';
import { consulFetch, describeError } from '../consul/consul-http';
import { consulKvRawPath } from '../routes';
import { AppConfig, buildConfig, KV_DEFAULTS, KvConfig, parseKvConfig, SERVICE_NAME } from './app-config';

export const KV_KEY = `config/${SERVICE_NAME}/data`;

/**
 * Reads the KV document once at startup. Any problem (Consul down, no key, bad YAML)
 * logs one warning and falls back to the defaults, so the service can start without Consul.
 */
export async function readKvConfig(consul: AppConfig['consul'], logger: Pick<Logger, 'warn'>): Promise<KvConfig> {
  let response: Response;
  try {
    response = await consulFetch(consul, consulKvRawPath(KV_KEY));
  } catch (error) {
    logger.warn({ reason: describeError(error) }, 'Consul is not reachable, using default configuration');
    return KV_DEFAULTS;
  }
  if (!response.ok) {
    logger.warn({ status: response.status, key: KV_KEY }, 'Consul KV key not available, using default configuration');
    return KV_DEFAULTS;
  }
  try {
    return parseKvConfig(await response.text());
  } catch (error) {
    logger.warn({ reason: describeError(error), key: KV_KEY }, 'Invalid YAML in Consul KV, using default configuration');
    return KV_DEFAULTS;
  }
}

/** Configuration priority: environment variables > Consul KV > defaults in code. */
export async function loadConfig(
  env: Record<string, string | undefined>,
  logger: Pick<Logger, 'warn'>,
): Promise<AppConfig> {
  const fromEnv = buildConfig(env, KV_DEFAULTS);
  if (!fromEnv.consul.enabled) {
    return fromEnv;
  }
  return buildConfig(env, await readKvConfig(fromEnv.consul, logger));
}
