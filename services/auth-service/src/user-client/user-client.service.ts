import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { setTimeout as delay } from 'node:timers/promises';
import CircuitBreaker from 'opossum';
import { AppException } from '../common/app-exception';
import { describeError } from '../consul/consul-http';
import { ServiceDiscovery } from '../consul/service-discovery.service';
import { USER_SERVICE_USERS_PATH } from '../routes';

export const USER_SERVICE = 'user-service';
// Timeout of one HTTP attempt (architecture rule).
export const ATTEMPT_TIMEOUT_MS = 2000;
export const RETRY_DELAY_MS = 200;

export const BREAKER_OPTIONS = {
  // No opossum timeout: each attempt has its own 2 s timeout (AbortSignal), so one call
  // (attempt + 200 ms + retry) ends after about 4.2 s at most.
  timeout: false,
  volumeThreshold: 10,
  errorThresholdPercentage: 50,
  resetTimeout: 30_000,
  rollingCountTimeout: 60_000,
} as const;

/** Body of POST /users (contract of User Service). */
export interface UserProfile {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

/** User Service answered with a status other than 200/201. */
export class UserServiceStatusError extends Error {
  constructor(readonly status: number) {
    super(`User Service responded with ${status}`);
    this.name = 'UserServiceStatusError';
  }
}

/**
 * 4xx other than 408 and 429 answer this particular request (e.g. 409): User Service works,
 * so the breaker does not count them as failures.
 */
export function isRequestRejection(error: unknown): boolean {
  return (
    error instanceof UserServiceStatusError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

/** Timeout, network error (fetch rejected) or 5xx. Other statuses are not retried. */
function isRetryable(error: unknown): boolean {
  return !(error instanceof UserServiceStatusError) || error.status >= 500;
}

// No connection to the instance (the same codes as in the Gateway): the instance is evicted (D13).
const CONNECTION_ERROR_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT']);

/** fetch rejected because the instance could not be reached (error.cause.code). */
function isConnectionError(error: unknown): boolean {
  const cause: unknown = error instanceof Error ? error.cause : undefined;
  return (
    cause !== null &&
    typeof cause === 'object' &&
    'code' in cause &&
    typeof cause.code === 'string' &&
    CONNECTION_ERROR_CODES.has(cause.code)
  );
}

function unavailable(): AppException {
  return new AppException(503, 'SERVICE_UNAVAILABLE', 'User Service is unavailable, try again later');
}

/**
 * Creates the user profile in User Service (POST /users) during registration.
 * Instance from Consul, 2 s per attempt, one retry with the same id (POST /users is idempotent by id),
 * circuit breaker around the whole call. Every failure becomes 503 SERVICE_UNAVAILABLE.
 * An instance without a connection is evicted and the retry goes to the next instance from Consul
 * (the same address when there is no other one).
 */
@Injectable()
export class UserClient implements OnModuleDestroy {
  // One breaker call = one profile creation with its retry, so "10 calls" means 10 registrations.
  private readonly breaker: CircuitBreaker<[string, UserProfile, string], void>;

  constructor(
    private readonly discovery: ServiceDiscovery,
    @InjectPinoLogger(UserClient.name) private readonly logger: PinoLogger,
  ) {
    this.breaker = new CircuitBreaker(
      (baseUrl: string, profile: UserProfile, requestId: string) => this.postWithRetry(baseUrl, profile, requestId),
      { ...BREAKER_OPTIONS, errorFilter: isRequestRejection },
    );
    this.breaker.on('open', () =>
      this.logger.warn({ targetService: USER_SERVICE }, 'Circuit breaker opened, User Service calls are rejected for 30 s'),
    );
    this.breaker.on('close', () => this.logger.info({ targetService: USER_SERVICE }, 'Circuit breaker closed'));
  }

  async createProfile(profile: UserProfile, requestId: string): Promise<void> {
    const baseUrl = await this.discovery.getInstance(USER_SERVICE);
    if (baseUrl === null) {
      this.logger.warn({ targetService: USER_SERVICE }, 'No healthy User Service instance in Consul');
      throw unavailable();
    }
    try {
      await this.breaker.fire(baseUrl, profile, requestId);
    } catch (error) {
      this.logger.warn(
        { targetService: USER_SERVICE, reason: describeError(error) },
        'User Service did not create the user profile',
      );
      throw unavailable();
    }
  }

  private async postWithRetry(baseUrl: string, profile: UserProfile, requestId: string): Promise<void> {
    try {
      await this.postOrEvict(baseUrl, profile, requestId);
    } catch (error) {
      if (!isRetryable(error)) {
        throw error;
      }
      this.logger.warn({ targetService: USER_SERVICE, reason: describeError(error) }, 'User Service call failed, retrying once');
      await delay(RETRY_DELAY_MS);
      const retryUrl = isConnectionError(error) ? ((await this.discovery.getInstance(USER_SERVICE)) ?? baseUrl) : baseUrl;
      await this.postOrEvict(retryUrl, profile, requestId);
    }
  }

  private async postOrEvict(baseUrl: string, profile: UserProfile, requestId: string): Promise<void> {
    try {
      await this.post(baseUrl, profile, requestId);
    } catch (error) {
      if (isConnectionError(error)) {
        this.discovery.evict(USER_SERVICE, baseUrl);
      }
      throw error;
    }
  }

  private async post(baseUrl: string, profile: UserProfile, requestId: string): Promise<void> {
    const response = await fetch(`${baseUrl}${USER_SERVICE_USERS_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': profile.id,
        'X-User-Roles': 'SERVICE',
        'X-Request-Id': requestId,
      },
      body: JSON.stringify(profile),
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
    // The response body is not used.
    await response.body?.cancel();
    if (response.status !== 200 && response.status !== 201) {
      throw new UserServiceStatusError(response.status);
    }
  }

  onModuleDestroy(): void {
    this.breaker.shutdown();
  }
}
