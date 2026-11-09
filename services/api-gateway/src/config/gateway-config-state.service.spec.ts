import { jest } from '@jest/globals';
import type { PinoLogger } from 'nestjs-pino';
import { readFileSync } from 'node:fs';
import { consulKvRawPath } from '../routes';
import { buildAppConfig } from './app-config';
import { CONFIG_RETRY_MS, GatewayConfigState, KV_KEY } from './gateway-config-state.service';

const KV_DOCUMENT = readFileSync('../../deploy/consul/config/api-gateway.yaml', 'utf8');
const ENV = { CONSUL_HOST: 'consul', REDIS_PASSWORD: 'test-redis' };

type Answer = () => Response | Error;

function mockConsul(initial: Answer) {
  let answer = initial;
  const spy = jest.spyOn(global, 'fetch').mockImplementation(() => {
    const result = answer();
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  return { spy, set: (next: Answer) => (answer = next) };
}

function createState(env: Record<string, string> = ENV) {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const state = new GatewayConfigState(buildAppConfig(env), logger as unknown as PinoLogger);
  return { state, logger };
}

describe('GatewayConfigState', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('is not loaded before start and loads the KV document on the first attempt', async () => {
    const { spy } = mockConsul(() => new Response(KV_DOCUMENT));
    const { state, logger } = createState();
    const onLoaded = jest.fn();
    expect(state.current()).toBeNull();

    await state.start(onLoaded);

    expect(spy).toHaveBeenCalledWith(`http://consul:8500${consulKvRawPath(KV_KEY)}`, expect.anything());
    expect(state.current()?.routes.get('auth')).toBe('auth-service');
    expect(onLoaded).toHaveBeenCalledWith(state.current());
    expect(logger.info).toHaveBeenCalledTimes(1);
    // Loaded once: no more reads.
    await jest.advanceTimersByTimeAsync(CONFIG_RETRY_MS * 3);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('applies environment overrides to the loaded document', async () => {
    mockConsul(() => new Response(KV_DOCUMENT));
    const { state } = createState({ ...ENV, LOG_LEVEL: 'debug', JWT_ISSUER: 'env-issuer' });
    await state.start();
    expect(state.current()?.logLevel).toBe('debug');
    expect(state.current()?.jwt.issuer).toBe('env-issuer');
  });

  it('retries every 15 s while Consul is down, with one warning, and loads when it is back', async () => {
    const consul = mockConsul(() => new TypeError('fetch failed'));
    const { state, logger } = createState();

    await state.start();
    expect(state.current()).toBeNull();
    await jest.advanceTimersByTimeAsync(CONFIG_RETRY_MS - 1);
    expect(consul.spy).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(consul.spy).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(CONFIG_RETRY_MS);
    expect(consul.spy).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toContain('Consul is not reachable');
    expect(state.current()).toBeNull();

    consul.set(() => new Response(KV_DOCUMENT));
    await jest.advanceTimersByTimeAsync(CONFIG_RETRY_MS);
    expect(state.current()).not.toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('warns once when the KV key is missing', async () => {
    mockConsul(() => new Response('', { status: 404 }));
    const { state, logger } = createState();
    await state.start();
    await jest.advanceTimersByTimeAsync(CONFIG_RETRY_MS * 2);
    expect(state.current()).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatchObject({ status: 404, key: KV_KEY });
  });

  it('logs one error for invalid YAML, without the document', async () => {
    mockConsul(() => new Response('routes: {a: [unclosed\nhidden-value-123'));
    const { state, logger } = createState();
    await state.start();
    await jest.advanceTimersByTimeAsync(CONFIG_RETRY_MS);
    expect(state.current()).toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][1]).toBe('Invalid YAML in gateway configuration');
    expect(JSON.stringify(logger.error.mock.calls[0])).not.toContain('hidden-value-123');
  });

  it('logs one error naming the field for a broken rule and stays not ready', async () => {
    mockConsul(() => new Response(KV_DOCUMENT.replace(/access: public \}$/m, 'access: everyone }')));
    const { state, logger } = createState();
    await state.start();
    await jest.advanceTimersByTimeAsync(CONFIG_RETRY_MS * 2);
    expect(state.current()).toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][1]).toBe(
      'Invalid gateway configuration: access[0].access must be one of public, authenticated, ADMIN, blocked',
    );
  });

  it('logs again when the kind of failure changes', async () => {
    const consul = mockConsul(() => new TypeError('fetch failed'));
    const { state, logger } = createState();
    await state.start();
    consul.set(() => new Error('The operation was aborted due to timeout'));
    await jest.advanceTimersByTimeAsync(CONFIG_RETRY_MS);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    consul.set(() => new Response('', { status: 404 }));
    await jest.advanceTimersByTimeAsync(CONFIG_RETRY_MS);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('stops retrying on shutdown', async () => {
    const { spy } = mockConsul(() => new TypeError('fetch failed'));
    const { state } = createState();
    await state.start();
    state.onApplicationShutdown();
    await jest.advanceTimersByTimeAsync(CONFIG_RETRY_MS * 2);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
