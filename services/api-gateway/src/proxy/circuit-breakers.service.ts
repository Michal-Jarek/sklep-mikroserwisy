import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import CircuitBreaker from 'opossum';
import { BREAKER_STATE, GatewayMetrics } from '../metrics/gateway-metrics';
import type { ForwardResult } from './upstream.service';

// Decision 12 (the same values as Auth -> User): open at more than 50% failures of at least 10 calls
// within 60 s, one trial request after 30 s. No timeout of its own: the proxy limits the time.
export const BREAKER_OPTIONS = {
  timeout: false,
  volumeThreshold: 10,
  errorThresholdPercentage: 50,
  resetTimeout: 30_000,
  rollingCountTimeout: 60_000,
} as const;

// Only network failures count (Z27): 502 and 504 are the statuses of a gateway in front of the service
// (its own proxy could not reach it). Every other status, also 500 and 503, is a success: the service
// answered fast, and a 500 caused by the request of one client must not switch the service off for others.
const FAILED_STATUSES = new Set([502, 504]);

/** Failure for the breaker (Z27): no connection, timeout, other I/O error, or a 502/504 response. */
export function isFailure(result: ForwardResult): boolean {
  if (result.kind === 'response') {
    return FAILED_STATUSES.has(result.statusCode);
  }
  // aborted: the client went away, nothing is known about the service; rejected: the request of the client
  // could not be sent at all (400). Neither says anything about the service.
  return result.kind !== 'aborted' && result.kind !== 'rejected';
}

/** Rejection that carries a failed result through opossum (the response may already be on its way). */
class UpstreamFailure extends Error {
  constructor(readonly result: ForwardResult) {
    super('Request to the service failed');
  }
}

type Call = () => Promise<ForwardResult>;

/**
 * One opossum circuit per target service (decision 12), created on the first request to the service.
 * Counts only network failures (isFailure, Z27). "No instance" is decided before run() and never counted.
 * Every change of state is logged and set in gateway_circuit_breaker_state.
 */
@Injectable()
export class CircuitBreakers {
  private readonly breakers = new Map<string, CircuitBreaker<[Call], ForwardResult>>();

  constructor(
    @InjectPinoLogger(CircuitBreakers.name) private readonly logger: PinoLogger,
    private readonly metrics: GatewayMetrics,
  ) {}

  /** The circuit rejects requests now: open, or half-open while its single trial request runs. */
  rejects(service: string): boolean {
    const breaker = this.breakers.get(service);
    return breaker !== undefined && !breaker.closed && !breaker.pendingClose;
  }

  /**
   * Runs one request to the service through its circuit and counts the outcome (failure per isFailure).
   * Returns the result also for a failure (the caller answers 502/504 or the response of the service is
   * already sent), null when the circuit rejected the request (open) — then call was not run.
   */
  async run(service: string, call: Call): Promise<ForwardResult | null> {
    try {
      return await this.breaker(service).fire(call);
    } catch (error) {
      if (error instanceof UpstreamFailure) {
        return error.result;
      }
      if ((error as { code?: string }).code === 'EOPENBREAKER') {
        return null;
      }
      throw error;
    }
  }

  private breaker(service: string): CircuitBreaker<[Call], ForwardResult> {
    let breaker = this.breakers.get(service);
    if (!breaker) {
      breaker = new CircuitBreaker(
        async (call: Call) => {
          const result = await call();
          if (isFailure(result)) {
            throw new UpstreamFailure(result);
          }
          return result;
        },
        { ...BREAKER_OPTIONS, name: service },
      );
      breaker.on('open', () => {
        this.metrics.setBreakerState(service, BREAKER_STATE.open);
        this.logger.warn({ targetService: service, state: 'open' }, 'Circuit breaker opened');
      });
      breaker.on('halfOpen', () => {
        this.metrics.setBreakerState(service, BREAKER_STATE.halfOpen);
        this.logger.info({ targetService: service, state: 'half-open' }, 'Circuit breaker half-open');
      });
      breaker.on('close', () => {
        this.metrics.setBreakerState(service, BREAKER_STATE.closed);
        this.logger.info({ targetService: service, state: 'closed' }, 'Circuit breaker closed');
      });
      this.metrics.setBreakerState(service, BREAKER_STATE.closed);
      this.breakers.set(service, breaker);
    }
    return breaker;
  }
}
