import { jest } from '@jest/globals';
import type { PinoLogger } from 'nestjs-pino';
import { GatewayMetrics } from '../metrics/gateway-metrics';
import { BREAKER_OPTIONS, CircuitBreakers, isFailure } from './circuit-breakers.service';
import type { ForwardResult } from './upstream.service';

const UPSTREAM = '10.0.0.1:8083';

function response(statusCode: number): ForwardResult {
  return { kind: 'response', statusCode, upstream: UPSTREAM };
}

const OK = response(200);
const ERROR_502 = response(502);

function createBreakers() {
  const logger = { warn: jest.fn(), info: jest.fn() };
  const metrics = new GatewayMetrics('api-gateway-test');
  const breakers = new CircuitBreakers(logger as unknown as PinoLogger, metrics);
  return { breakers, logger, metrics };
}

/** gateway_circuit_breaker_state of the service, undefined while the service has no circuit. */
async function breakerState(metrics: GatewayMetrics, service: string): Promise<number | undefined> {
  const metric = await metrics.registry.getSingleMetric('gateway_circuit_breaker_state')?.get();
  return metric?.values.find((value) => value.labels.service === service)?.value;
}

async function runMany(breakers: CircuitBreakers, service: string, result: ForwardResult, count: number) {
  const outcomes: (ForwardResult | null)[] = [];
  for (let i = 0; i < count; i += 1) {
    outcomes.push(await breakers.run(service, () => Promise.resolve(result)));
  }
  return outcomes;
}

describe('isFailure (decision 12, Z27: only network failures)', () => {
  it.each([502, 504])('response %i -> failure', (status) => {
    expect(isFailure(response(status))).toBe(true);
  });

  it.each([200, 201, 204, 301, 400, 401, 403, 404, 409, 429, 500, 501, 503, 505])('response %i -> success', (status) => {
    expect(isFailure(response(status))).toBe(false);
  });

  it.each(['unreachable', 'timeout', 'failed'] as const)('%s -> failure', (kind) => {
    expect(isFailure({ kind, upstream: UPSTREAM })).toBe(true);
  });

  it('aborted (the client left) -> not a failure', () => {
    expect(isFailure({ kind: 'aborted', upstream: UPSTREAM })).toBe(false);
  });

  it('rejected (the request of the client could not be sent, 400) -> not a failure', () => {
    expect(isFailure({ kind: 'rejected', upstream: UPSTREAM })).toBe(false);
  });
});

describe('CircuitBreakers (decision 12, fake clock)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('has the options of decision 12', () => {
    expect(BREAKER_OPTIONS).toEqual({
      timeout: false,
      volumeThreshold: 10,
      errorThresholdPercentage: 50,
      resetTimeout: 30_000,
      rollingCountTimeout: 60_000,
    });
  });

  it('returns every result, also failures (the caller decides 502/504 or the response is already sent)', async () => {
    const { breakers } = createBreakers();
    expect(await breakers.run('product-service', () => Promise.resolve(ERROR_502))).toBe(ERROR_502);
    const timeout: ForwardResult = { kind: 'timeout', upstream: UPSTREAM };
    expect(await breakers.run('product-service', () => Promise.resolve(timeout))).toBe(timeout);
    expect(await breakers.run('product-service', () => Promise.resolve(OK))).toBe(OK);
  });

  it('9 failures do not open (volume threshold 10), the 10th does; then rejected without calling the service', async () => {
    const { breakers, logger } = createBreakers();
    await runMany(breakers, 'product-service', ERROR_502, 9);
    expect(breakers.rejects('product-service')).toBe(false);
    await runMany(breakers, 'product-service', { kind: 'unreachable', upstream: UPSTREAM }, 1);
    expect(breakers.rejects('product-service')).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith({ targetService: 'product-service', state: 'open' }, 'Circuit breaker opened');

    const call = jest.fn(() => Promise.resolve(OK));
    expect(await breakers.run('product-service', call)).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('exactly 50% failures of 10 calls keeps it closed, more than 50% opens it', async () => {
    const { breakers } = createBreakers();
    await runMany(breakers, 'a', OK, 5);
    await runMany(breakers, 'a', ERROR_502, 5);
    expect(breakers.rejects('a')).toBe(false);
    await runMany(breakers, 'a', ERROR_502, 1);
    expect(breakers.rejects('a')).toBe(true);
  });

  it('4xx responses are successes: 20 x 404 keep it closed (K48)', async () => {
    const { breakers } = createBreakers();
    await runMany(breakers, 'product-service', response(404), 20);
    expect(breakers.rejects('product-service')).toBe(false);
  });

  it('500 and 503 responses are successes: 20 x 500 and 20 x 503 keep it closed (K47, Z27)', async () => {
    const { breakers, logger } = createBreakers();
    await runMany(breakers, 'product-service', response(500), 20);
    await runMany(breakers, 'product-service', response(503), 20);
    expect(breakers.rejects('product-service')).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(await breakers.run('product-service', () => Promise.resolve(OK))).toBe(OK);
  });

  it('failures older than the 60 s rolling window are forgotten', async () => {
    const { breakers } = createBreakers();
    await runMany(breakers, 'a', ERROR_502, 9);
    await jest.advanceTimersByTimeAsync(61_000);
    await runMany(breakers, 'a', ERROR_502, 1);
    expect(breakers.rejects('a')).toBe(false);
  });

  it('after 30 s half-open: one trial request, the others rejected; success closes, failure opens again', async () => {
    const { breakers, logger } = createBreakers();
    await runMany(breakers, 'a', ERROR_502, 10);
    await jest.advanceTimersByTimeAsync(29_000);
    expect(breakers.rejects('a')).toBe(true);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(breakers.rejects('a')).toBe(false);
    expect(logger.info).toHaveBeenCalledWith({ targetService: 'a', state: 'half-open' }, 'Circuit breaker half-open');

    // The trial request is running: everyone else is rejected.
    let finishTrial: (result: ForwardResult) => void = () => undefined;
    const trial = breakers.run('a', () => new Promise<ForwardResult>((resolve) => (finishTrial = resolve)));
    expect(breakers.rejects('a')).toBe(true);
    expect(await breakers.run('a', () => Promise.resolve(OK))).toBeNull();
    finishTrial(ERROR_502);
    expect(await trial).toBe(ERROR_502);
    expect(breakers.rejects('a')).toBe(true);

    await jest.advanceTimersByTimeAsync(30_000);
    expect(await breakers.run('a', () => Promise.resolve(OK))).toBe(OK);
    expect(breakers.rejects('a')).toBe(false);
    expect(logger.info).toHaveBeenCalledWith({ targetService: 'a', state: 'closed' }, 'Circuit breaker closed');
  });

  it.each(['aborted', 'rejected'] as const)(
    'a trial request that ends %s settles and closes the circuit instead of blocking it (pitfall 5a, Z19)',
    async (kind) => {
      const { breakers, logger } = createBreakers();
      await runMany(breakers, 'a', ERROR_502, 10);
      await jest.advanceTimersByTimeAsync(30_000);
      expect(await breakers.run('a', () => Promise.resolve({ kind, upstream: UPSTREAM }))).toEqual({ kind, upstream: UPSTREAM });
      expect(breakers.rejects('a')).toBe(false);
      expect(logger.info).toHaveBeenCalledWith({ targetService: 'a', state: 'closed' }, 'Circuit breaker closed');
    },
  );

  it('rejected requests never open the circuit: 20 x rejected (W1)', async () => {
    const { breakers } = createBreakers();
    await runMany(breakers, 'auth-service', { kind: 'rejected', upstream: UPSTREAM }, 20);
    expect(breakers.rejects('auth-service')).toBe(false);
  });

  it('one circuit per service: an open product-service does not affect review-service (E4)', async () => {
    const { breakers } = createBreakers();
    await runMany(breakers, 'product-service', ERROR_502, 10);
    expect(breakers.rejects('product-service')).toBe(true);
    expect(breakers.rejects('review-service')).toBe(false);
    expect(await breakers.run('review-service', () => Promise.resolve(OK))).toBe(OK);
  });

  it('gateway_circuit_breaker_state: 0 when created, 2 open, 1 half-open, 0 closed again (K1)', async () => {
    const { breakers, metrics } = createBreakers();
    expect(await breakerState(metrics, 'a')).toBeUndefined();
    await runMany(breakers, 'a', OK, 1);
    expect(await breakerState(metrics, 'a')).toBe(0);
    await runMany(breakers, 'a', ERROR_502, 10);
    expect(await breakerState(metrics, 'a')).toBe(2);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(await breakerState(metrics, 'a')).toBe(1);
    await runMany(breakers, 'a', OK, 1);
    expect(await breakerState(metrics, 'a')).toBe(0);
    // Other services keep their own series.
    expect(await breakerState(metrics, 'b')).toBeUndefined();
  });

  it('an unknown service has no circuit yet and is not rejected', () => {
    const { breakers } = createBreakers();
    expect(breakers.rejects('cart-service')).toBe(false);
  });

  it('an unexpected error of the call is passed on', async () => {
    const { breakers } = createBreakers();
    await expect(breakers.run('a', () => Promise.reject(new Error('bug')))).rejects.toThrow('bug');
  });
});
