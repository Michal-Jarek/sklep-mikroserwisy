import { jest } from '@jest/globals';
import type { PinoLogger } from 'nestjs-pino';
import type { Instance, ServiceDiscovery } from '../consul/service-discovery.service';
import { AUTH_JWKS_PATH } from '../routes';
import {
  AUTH_SERVICE,
  JWKS_MAX_AGE_MS,
  JWKS_MIN_INTERVAL_MS,
  JWKS_TIMEOUT_MS,
  JwksProvider,
  signingKeys,
} from './jwks-provider.service';

const AUTH: Instance = { id: 'auth-service-1', address: '10.0.0.9', port: 8081 };
// Waiting for a kid that is never published joins the request in progress.
const NEVER_PUBLISHED = 'never-published';

function rsa(kid: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { kty: 'RSA', kid, n: `n-${kid}`, e: 'AQAB', alg: 'RS256', use: 'sig', ...extra };
}

function jwks(...keys: unknown[]): Response {
  return new Response(JSON.stringify({ keys }));
}

type Answer = () => Response | Error | Promise<Response>;

function setup(initial: Answer, instance: Instance | null = AUTH) {
  let answer = initial;
  const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(() => {
    const result = answer();
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  const discovery = { getInstance: jest.fn(() => Promise.resolve(instance)), evict: jest.fn() };
  const logger = { info: jest.fn(), warn: jest.fn() };
  const provider = new JwksProvider(discovery as unknown as ServiceDiscovery, logger as unknown as PinoLogger);
  return { provider, fetchSpy, discovery, logger, set: (next: Answer) => (answer = next) };
}

function deferred(): { promise: Promise<Response>; resolve: (response: Response) => void } {
  let resolve: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((done) => (resolve = done));
  return { promise, resolve };
}

async function kids(provider: JwksProvider, kid: string): Promise<string[] | null> {
  const keys = await provider.keysFor(kid);
  return keys ? [...keys.kids] : null;
}

describe('signingKeys', () => {
  it('keeps only public RSA signing keys with a kid (alg RS256 or none, use sig or none)', () => {
    const keys = signingKeys({
      keys: [
        rsa('ok'),
        { kty: 'EC', kid: 'ec', crv: 'P-256', x: 'x', y: 'y', alg: 'ES256' },
        rsa('rs512', { alg: 'RS512' }),
        rsa('enc', { use: 'enc' }),
        { kty: 'RSA', n: 'n', e: 'AQAB' },
        rsa('no-alg-no-use', { alg: undefined, use: undefined }),
        rsa('no-modulus', { n: undefined }),
        rsa('private', { d: 'private-exponent', p: 'p', q: 'q' }),
        null,
        'text',
      ],
    });
    expect(keys.map((key) => key.kid)).toEqual(['ok', 'no-alg-no-use', 'private']);
    expect(keys[2]).toEqual({ kty: 'RSA', kid: 'private', n: 'n-private', e: 'AQAB', alg: 'RS256', use: 'sig' });
  });

  it.each([null, 'text', {}, { keys: 'x' }, [rsa('k1')]])('throws for a document without a keys list: %j', (body) => {
    expect(() => signingKeys(body)).toThrow('JWKS response without a keys list');
  });
});

describe('JwksProvider', () => {
  let now = 5_000_000;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fetches the keys in the background at startup from an auth-service instance found in Consul', async () => {
    const { provider, fetchSpy, discovery, logger } = setup(() => jwks(rsa('k1')));

    expect(provider.onApplicationBootstrap()).toBeUndefined();
    expect(await kids(provider, 'k1')).toEqual(['k1']);

    expect(discovery.getInstance).toHaveBeenCalledWith(AUTH_SERVICE);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`http://10.0.0.9:8081${AUTH_JWKS_PATH}`);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JWKS_TIMEOUT_MS).toBe(2000);
    expect(logger.info).toHaveBeenCalledWith({ keys: 1 }, 'JWKS keys loaded from Auth Service');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('unknown kid: the caller waits for one refresh and gets the new key', async () => {
    const { provider, fetchSpy, set } = setup(() => jwks(rsa('k1')));
    provider.onApplicationBootstrap();
    await kids(provider, 'k1');

    now += JWKS_MIN_INTERVAL_MS;
    set(() => jwks(rsa('k2')));
    expect(await kids(provider, 'k2')).toEqual(['k2']);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('another unknown kid within 10 s: no request, the current keys are returned', async () => {
    const { provider, fetchSpy } = setup(() => jwks(rsa('k1')));
    await kids(provider, 'k1');

    now += JWKS_MIN_INTERVAL_MS - 1;
    expect(await kids(provider, 'k2')).toEqual(['k1']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    now += 1;
    await kids(provider, 'k2');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('refreshes keys older than 10 min in the background; the caller does not wait', async () => {
    const { provider, fetchSpy, set } = setup(() => jwks(rsa('k1')));
    await kids(provider, 'k1');

    now += JWKS_MAX_AGE_MS - 1;
    await kids(provider, 'k1');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    now += 1;
    const answer = deferred();
    set(() => answer.promise);
    expect(await kids(provider, 'k1')).toEqual(['k1']); // resolved while the request is still open
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    answer.resolve(jwks(rsa('k1'), rsa('k2')));
    await provider.keysFor(NEVER_PUBLISHED);
    expect(await kids(provider, 'k1')).toEqual(['k1', 'k2']);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('keeps the current keys when Auth is down (one warning), evicts the instance, logs the recovery once', async () => {
    const { provider, discovery, logger, set } = setup(() => jwks(rsa('k1')));
    await kids(provider, 'k1');

    set(() => new TypeError('fetch failed'));
    for (let i = 0; i < 3; i += 1) {
      now += JWKS_MAX_AGE_MS;
      expect(await kids(provider, 'k1')).toEqual(['k1']);
      await provider.keysFor(NEVER_PUBLISHED);
    }
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { reason: 'fetch failed' },
      'JWKS refresh from Auth Service failed, keeping the current keys',
    );
    expect(discovery.evict).toHaveBeenCalledWith(AUTH_SERVICE, AUTH);

    set(() => jwks(rsa('k1')));
    now += JWKS_MIN_INTERVAL_MS;
    await provider.keysFor(NEVER_PUBLISHED);
    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenLastCalledWith({ keys: 1 }, 'JWKS keys loaded from Auth Service');

    set(() => new TypeError('fetch failed'));
    now += JWKS_MIN_INTERVAL_MS;
    await provider.keysFor(NEVER_PUBLISHED);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('without an auth-service instance: null keys, one warning, no exception', async () => {
    const { provider, fetchSpy, discovery, logger } = setup(() => jwks(rsa('k1')), null);
    provider.onApplicationBootstrap();
    expect(await provider.keysFor('k1')).toBeNull();
    now += JWKS_MIN_INTERVAL_MS;
    expect(await provider.keysFor('k1')).toBeNull();

    expect(discovery.getInstance).toHaveBeenCalledTimes(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { reason: 'No healthy instance of auth-service' },
      'No JWKS keys from Auth Service, routes that need a login answer 503',
    );
  });

  it('an error status or a document without a usable key is a failed refresh (keys kept, no eviction)', async () => {
    const { provider, discovery, logger, set } = setup(() => jwks(rsa('k1')));
    await kids(provider, 'k1');

    set(() => new Response('{}', { status: 503 }));
    now += JWKS_MIN_INTERVAL_MS;
    expect(await kids(provider, 'k2')).toEqual(['k1']);

    set(() => jwks({ kty: 'EC', kid: 'k2', crv: 'P-256', x: 'x', y: 'y' }, rsa('k3', { alg: 'RS512' })));
    now += JWKS_MIN_INTERVAL_MS;
    expect(await kids(provider, 'k2')).toEqual(['k1']);

    set(() => new Response('not json'));
    now += JWKS_MIN_INTERVAL_MS;
    expect(await kids(provider, 'k2')).toEqual(['k1']);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { reason: 'Auth Service responded with 503' },
      'JWKS refresh from Auth Service failed, keeping the current keys',
    );
    expect(discovery.evict).not.toHaveBeenCalled();
  });

  it('10 concurrent callers with an unknown kid share one request', async () => {
    const answer = deferred();
    const { provider, fetchSpy } = setup(() => answer.promise);

    const pending = Promise.all(Array.from({ length: 10 }, () => kids(provider, 'k1')));
    answer.resolve(jwks(rsa('k1')));

    expect(await pending).toEqual(Array.from({ length: 10 }, () => ['k1']));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
