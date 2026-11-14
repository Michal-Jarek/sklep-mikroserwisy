import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { createLocalJWKSet, type JWK } from 'jose';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { describeError } from '../consul/consul-http';
import { ServiceDiscovery } from '../consul/service-discovery.service';
import { AUTH_JWKS_PATH } from '../routes';
import type { KeySet } from './access-token';

// Name of Auth Service in Consul.
export const AUTH_SERVICE = 'auth-service';
// Timeout of the JWKS request (architecture rule: 2 s per call to another service).
export const JWKS_TIMEOUT_MS = 2000;
// At most one JWKS request per 10 s; this limit is the circuit breaker of this call (decision 14).
export const JWKS_MIN_INTERVAL_MS = 10_000;
// Keys older than this are refreshed in the background.
export const JWKS_MAX_AGE_MS = 10 * 60_000;

export interface VerificationKeys {
  keySet: KeySet;
  kids: ReadonlySet<string>;
}

type KeysState = 'initial' | 'loaded' | 'stale' | 'missing';
// Where the keys come from (field "source" of the log lines): AUTH_JWKS_ORIGIN or an instance from Consul.
type KeysSource = 'origin' | 'consul';

function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Public RSA signing keys with a kid from a JWKS document: alg RS256 or none, use sig or none.
 * Only the public members are kept. Throws when the document has no keys list.
 */
export function signingKeys(body: unknown): JWK[] {
  if (!isMapping(body) || !Array.isArray(body.keys)) {
    throw new Error('JWKS response without a keys list');
  }
  const keys: JWK[] = [];
  for (const key of body.keys as unknown[]) {
    if (
      isMapping(key) &&
      key.kty === 'RSA' &&
      (key.alg === undefined || key.alg === 'RS256') &&
      (key.use === undefined || key.use === 'sig') &&
      typeof key.kid === 'string' &&
      key.kid !== '' &&
      typeof key.n === 'string' &&
      typeof key.e === 'string'
    ) {
      keys.push({ kty: 'RSA', kid: key.kid, n: key.n, e: key.e, alg: 'RS256', use: 'sig' });
    }
  }
  return keys;
}

/**
 * Keys of Auth Service for access tokens (decision 14). Fetched from AUTH_JWKS_ORIGIN when it is set
 * (Kubernetes Service, stage 7 decision 8: an instance registered in Consul cannot supply the keys),
 * otherwise from an auth-service instance found in Consul: first in the background at startup, then
 * when a token has an unknown kid (the request waits) or the keys are older than 10 min (in the
 * background). At most one request per 10 s; concurrent callers share it. When a request fails, the
 * current keys stay (one warning per change of state). null = no keys yet: routes that need a login
 * answer 503.
 */
@Injectable()
export class JwksProvider implements OnApplicationBootstrap {
  private keys: VerificationKeys | null = null;
  private fetchedAt = 0;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  private pending?: Promise<void>;
  private state: KeysState = 'initial';
  private readonly source: KeysSource;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly discovery: ServiceDiscovery,
    @InjectPinoLogger(JwksProvider.name) private readonly logger: PinoLogger,
  ) {
    this.source = config.authJwksOrigin ? 'origin' : 'consul';
  }

  onApplicationBootstrap(): void {
    void this.refresh();
  }

  /** Keys to verify a token signed with kid; null when there are no keys at all. */
  async keysFor(kid: string): Promise<VerificationKeys | null> {
    if (this.keys?.kids.has(kid)) {
      if (Date.now() - this.fetchedAt >= JWKS_MAX_AGE_MS) {
        void this.refresh();
      }
      return this.keys;
    }
    await this.refresh();
    return this.keys;
  }

  /** Joins the running request, or starts one unless the last one started less than 10 s ago. Never rejects. */
  private refresh(): Promise<void> {
    if (this.pending) {
      return this.pending;
    }
    const now = Date.now();
    if (now - this.lastAttemptAt < JWKS_MIN_INTERVAL_MS) {
      return Promise.resolve();
    }
    this.lastAttemptAt = now;
    this.pending = this.load().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async load(): Promise<void> {
    try {
      const keys = await this.download();
      this.keys = { keySet: createLocalJWKSet({ keys }), kids: new Set(keys.map((key) => key.kid as string)) };
      this.fetchedAt = Date.now();
      if (this.state !== 'loaded') {
        this.state = 'loaded';
        this.logger.info({ keys: keys.length, source: this.source }, 'JWKS keys loaded from Auth Service');
      }
    } catch (error) {
      const next: KeysState = this.keys ? 'stale' : 'missing';
      if (next !== this.state) {
        this.state = next;
        this.logger.warn(
          { reason: describeError(error), source: this.source },
          next === 'stale'
            ? 'JWKS refresh from Auth Service failed, keeping the current keys'
            : 'No JWKS keys from Auth Service, routes that need a login answer 503',
        );
      }
    }
  }

  private async download(): Promise<JWK[]> {
    let response: Response;
    if (this.config.authJwksOrigin) {
      // The Service balances over the Auth pods itself: no Consul, nothing to evict.
      response = await fetch(`${this.config.authJwksOrigin}${AUTH_JWKS_PATH}`, {
        signal: AbortSignal.timeout(JWKS_TIMEOUT_MS),
      });
    } else {
      const instance = await this.discovery.getInstance(AUTH_SERVICE);
      if (!instance) {
        throw new Error(`No healthy instance of ${AUTH_SERVICE}`);
      }
      try {
        response = await fetch(`http://${instance.address}:${instance.port}${AUTH_JWKS_PATH}`, {
          signal: AbortSignal.timeout(JWKS_TIMEOUT_MS),
        });
      } catch (error) {
        // No answer from this instance: the next attempt (and the proxy) takes another one.
        this.discovery.evict(AUTH_SERVICE, instance);
        throw error;
      }
    }
    if (!response.ok) {
      throw new Error(`Auth Service responded with ${response.status}`);
    }
    const keys = signingKeys(await response.json());
    if (keys.length === 0) {
      throw new Error('JWKS response without an RS256 signing key');
    }
    return keys;
  }
}
