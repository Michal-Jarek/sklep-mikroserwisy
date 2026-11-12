import { jest } from '@jest/globals';
import type { FastifyInstance } from 'fastify';
import { parseTrustedProxies } from '../config/app-config';
import { createFastifyAdapter } from './fastify-adapter';
import {
  type LookupAll,
  normalizeAddress,
  TRUSTED_PROXIES_REFRESH_MS,
  TRUSTED_PROXIES_STALE_MS,
  TRUSTED_PROXIES_START_WAIT_MS,
  TrustedProxies,
} from './trusted-proxies';

function createLogger() {
  return { info: jest.fn(), warn: jest.fn() };
}

function trusted(value: string, lookup?: LookupAll) {
  const logger = createLogger();
  const lookupMock = jest.fn<LookupAll>(lookup ?? (() => Promise.reject(new Error('no DNS in this test'))));
  return { proxies: new TrustedProxies(parseTrustedProxies(value), logger, lookupMock), logger, lookup: lookupMock };
}

describe('TrustedProxies', () => {
  describe('addresses and ranges', () => {
    it('trusts an IPv4 address and nothing else', () => {
      const { proxies } = trusted('172.18.0.5');
      expect(proxies.isTrusted('172.18.0.5')).toBe(true);
      expect(proxies.isTrusted('172.18.0.6')).toBe(false);
      expect(proxies.isTrusted('127.0.0.1')).toBe(false);
    });

    it('trusts an IPv6 address in any notation', () => {
      const { proxies } = trusted('fd00::5');
      expect(proxies.isTrusted('fd00::5')).toBe(true);
      expect(proxies.isTrusted('fd00:0:0:0:0:0:0:5')).toBe(true);
      expect(proxies.isTrusted('fd00::6')).toBe(false);
    });

    it('trusts IPv4 and IPv6 CIDR ranges', () => {
      const { proxies } = trusted('10.42.0.0/16, fd00:1::/64');
      expect(proxies.isTrusted('10.42.0.1')).toBe(true);
      expect(proxies.isTrusted('10.42.255.254')).toBe(true);
      expect(proxies.isTrusted('10.43.0.1')).toBe(false);
      expect(proxies.isTrusted('fd00:1::abcd')).toBe(true);
      expect(proxies.isTrusted('fd00:2::1')).toBe(false);
    });

    it('normalizes ::ffff:a.b.c.d to IPv4', () => {
      expect(normalizeAddress('::ffff:172.18.0.5')).toBe('172.18.0.5');
      expect(normalizeAddress('::FFFF:10.0.0.1')).toBe('10.0.0.1');
      expect(normalizeAddress('fd00::5')).toBe('fd00::5');
      expect(normalizeAddress('::ffff:999.0.0.1')).toBe('::ffff:999.0.0.1');
      const { proxies } = trusted('172.18.0.5,10.0.0.0/8');
      expect(proxies.isTrusted('::ffff:172.18.0.5')).toBe(true);
      expect(proxies.isTrusted('::ffff:10.1.2.3')).toBe(true);
      expect(proxies.isTrusted('::ffff:172.18.0.6')).toBe(false);
    });

    it('an empty variable trusts nobody and resolves nothing', async () => {
      for (const value of ['', ' ', ',']) {
        const { proxies, lookup } = trusted(value);
        await proxies.start();
        expect(proxies.isTrusted('127.0.0.1')).toBe(false);
        expect(proxies.isTrusted('172.18.0.5')).toBe(false);
        expect(lookup).not.toHaveBeenCalled();
      }
      const { proxies } = trusted('10.0.0.1');
      expect(proxies.isTrusted(undefined)).toBe(false);
      expect(proxies.isTrusted('not-an-address')).toBe(false);
    });
  });

  describe('host names (DNS replaced by a stub)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('resolves a host name at startup with all its addresses and logs them', async () => {
      const { proxies, logger, lookup } = trusted('frontend', () => Promise.resolve(['172.18.0.5', '::ffff:172.18.0.9']));
      expect(proxies.isTrusted('172.18.0.5')).toBe(false);
      await proxies.start();
      expect(lookup).toHaveBeenCalledWith('frontend');
      expect(proxies.isTrusted('172.18.0.5')).toBe(true);
      expect(proxies.isTrusted('172.18.0.9')).toBe(true);
      expect(proxies.isTrusted('172.18.0.6')).toBe(false);
      expect(logger.info).toHaveBeenCalledWith({ trustedProxies: { frontend: ['172.18.0.5', '172.18.0.9'] } }, 'Trusted proxies updated');
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('resolves again every 10 s: a new address is trusted, the old one is not; an unchanged set is not logged again', async () => {
      let answer = ['172.18.0.5'];
      const { proxies, logger, lookup } = trusted('frontend', () => Promise.resolve(answer));
      await proxies.start();
      await jest.advanceTimersByTimeAsync(TRUSTED_PROXIES_REFRESH_MS);
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(logger.info).toHaveBeenCalledTimes(1);

      answer = ['172.18.0.7'];
      await jest.advanceTimersByTimeAsync(TRUSTED_PROXIES_REFRESH_MS);
      expect(lookup).toHaveBeenCalledTimes(3);
      expect(proxies.isTrusted('172.18.0.7')).toBe(true);
      expect(proxies.isTrusted('172.18.0.5')).toBe(false);
      expect(logger.info).toHaveBeenLastCalledWith({ trustedProxies: { frontend: ['172.18.0.7'] } }, 'Trusted proxies updated');
    });

    // What dns.lookup rejects with: ENOTFOUND for a name that does not exist (NXDOMAIN), EAI_AGAIN for a temporary failure.
    const dnsError = (code: string): Error => Object.assign(new Error(`getaddrinfo ${code} frontend`), { code });

    it('a name that does not exist (ENOTFOUND) is not trusted at once; it is trusted again when it comes back', async () => {
      let answer: () => Promise<string[]> = () => Promise.resolve(['172.18.0.5']);
      const { proxies, logger } = trusted('frontend', () => answer());
      await proxies.start();
      expect(proxies.isTrusted('172.18.0.5')).toBe(true);

      answer = () => Promise.reject(dnsError('ENOTFOUND'));
      await jest.advanceTimersByTimeAsync(TRUSTED_PROXIES_REFRESH_MS);
      expect(proxies.isTrusted('172.18.0.5')).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        { trustedProxy: 'frontend', reason: 'getaddrinfo ENOTFOUND frontend' },
        'Trusted proxy frontend cannot be resolved: the name does not exist, it is not trusted',
      );
      expect(logger.info).toHaveBeenLastCalledWith({ trustedProxies: { frontend: [] } }, 'Trusted proxies updated');
      // One warning per change of state.
      await jest.advanceTimersByTimeAsync(TRUSTED_PROXIES_REFRESH_MS * 3);
      expect(logger.warn).toHaveBeenCalledTimes(1);

      answer = () => Promise.resolve(['172.18.0.7']);
      await jest.advanceTimersByTimeAsync(TRUSTED_PROXIES_REFRESH_MS);
      expect(proxies.isTrusted('172.18.0.7')).toBe(true);
      expect(logger.info).toHaveBeenCalledWith({ trustedProxy: 'frontend' }, 'Trusted proxy frontend can be resolved again');
      expect(logger.info).toHaveBeenLastCalledWith({ trustedProxies: { frontend: ['172.18.0.7'] } }, 'Trusted proxies updated');
    });

    it('a temporary DNS error keeps the last addresses for less than 60 s after the last success, then nothing is trusted', async () => {
      let fail = false;
      const { proxies, logger } = trusted('frontend', () => (fail ? Promise.reject(dnsError('EAI_AGAIN')) : Promise.resolve(['172.18.0.5'])));
      await proxies.start();
      fail = true;
      // Lookups 10 s ... 50 s after the last success fail: the address stays trusted, one warning.
      await jest.advanceTimersByTimeAsync(TRUSTED_PROXIES_STALE_MS - TRUSTED_PROXIES_REFRESH_MS);
      expect(proxies.isTrusted('172.18.0.5')).toBe(true);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        { trustedProxy: 'frontend', reason: 'getaddrinfo EAI_AGAIN frontend' },
        'Trusted proxy frontend cannot be resolved, its last known addresses stay trusted for at most 60 s',
      );
      expect(logger.info).toHaveBeenCalledTimes(1);

      // The lookup 60 s after the last success fails too: the name is not trusted any more.
      await jest.advanceTimersByTimeAsync(TRUSTED_PROXIES_REFRESH_MS);
      expect(proxies.isTrusted('172.18.0.5')).toBe(false);
      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenLastCalledWith(
        { trustedProxy: 'frontend', reason: 'getaddrinfo EAI_AGAIN frontend' },
        'Trusted proxy frontend cannot be resolved, it is not trusted',
      );
      expect(logger.info).toHaveBeenLastCalledWith({ trustedProxies: { frontend: [] } }, 'Trusted proxies updated');

      fail = false;
      await jest.advanceTimersByTimeAsync(TRUSTED_PROXIES_REFRESH_MS);
      expect(proxies.isTrusted('172.18.0.5')).toBe(true);
    });

    it('a temporary error after a success starts the 60 s again', async () => {
      let fail = false;
      const { proxies } = trusted('frontend', () => (fail ? Promise.reject(dnsError('EAI_AGAIN')) : Promise.resolve(['172.18.0.5'])));
      await proxies.start();
      fail = true;
      await jest.advanceTimersByTimeAsync(TRUSTED_PROXIES_STALE_MS - TRUSTED_PROXIES_REFRESH_MS);
      fail = false;
      await jest.advanceTimersByTimeAsync(TRUSTED_PROXIES_REFRESH_MS);
      fail = true;
      await jest.advanceTimersByTimeAsync(TRUSTED_PROXIES_STALE_MS - TRUSTED_PROXIES_REFRESH_MS);
      expect(proxies.isTrusted('172.18.0.5')).toBe(true);
    });

    it('before the first successful lookup nobody is trusted; a later success counts', async () => {
      let fail = true;
      const { proxies, logger } = trusted('frontend, 10.0.0.1', () =>
        fail ? Promise.reject(dnsError('EAI_AGAIN')) : Promise.resolve(['172.18.0.5']),
      );
      await proxies.start();
      expect(proxies.isTrusted('172.18.0.5')).toBe(false);
      // The fixed entries work without DNS.
      expect(proxies.isTrusted('10.0.0.1')).toBe(true);
      expect(logger.warn).toHaveBeenCalledTimes(1);

      fail = false;
      await jest.advanceTimersByTimeAsync(TRUSTED_PROXIES_REFRESH_MS);
      expect(proxies.isTrusted('172.18.0.5')).toBe(true);
    });

    it('the startup waits at most 2 s for DNS; the late answer is used when it comes', async () => {
      let answer: (addresses: string[]) => void = () => undefined;
      const { proxies, lookup } = trusted('frontend', () => new Promise<string[]>((resolve) => (answer = resolve)));
      let started = false;
      const start = proxies.start().then(() => (started = true));
      await jest.advanceTimersByTimeAsync(TRUSTED_PROXIES_START_WAIT_MS - 1);
      expect(started).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await start;
      expect(started).toBe(true);
      expect(proxies.isTrusted('172.18.0.5')).toBe(false);

      // A slow lookup is not repeated while it is pending.
      await jest.advanceTimersByTimeAsync(TRUSTED_PROXIES_REFRESH_MS);
      expect(lookup).toHaveBeenCalledTimes(1);
      answer(['172.18.0.5']);
      await jest.advanceTimersByTimeAsync(0);
      expect(proxies.isTrusted('172.18.0.5')).toBe(true);
    });
  });

  // A real server on a random port (no inject: Jest cannot load its ESM-only dependency on Node 22).
  describe('request.ip with the Gateway adapter (trustProxy)', () => {
    let server: FastifyInstance | undefined;

    afterEach(async () => {
      await server?.close();
      server = undefined;
    });

    async function ipSeenBy(proxies: TrustedProxies, headers: Record<string, string>): Promise<string> {
      const adapter = createFastifyAdapter('api-gateway-test', { info: jest.fn() }, (address) => proxies.isTrusted(address));
      server = adapter.getInstance<FastifyInstance>();
      server.get('/ip', (request) => ({ ip: request.ip }));
      const url = await server.listen({ port: 0, host: '127.0.0.1' });
      const response = await fetch(`${url}/ip`, { headers });
      return ((await response.json()) as { ip: string }).ip;
    }

    it('from a trusted peer request.ip is the last X-Forwarded-For entry', async () => {
      expect(await ipSeenBy(trusted('127.0.0.1').proxies, { 'X-Forwarded-For': '1.2.3.4, 10.0.0.9' })).toBe('10.0.0.9');
    });

    it('a trusted peer without X-Forwarded-For: the connection address', async () => {
      expect(await ipSeenBy(trusted('127.0.0.0/8').proxies, {})).toBe('127.0.0.1');
    });

    it('only the direct peer (hop 0) is trusted: a trusted address deeper in X-Forwarded-For is not followed', async () => {
      // 10.0.0.9 is trusted too, but it is not the peer: its own X-Forwarded-For entry (1.2.3.4) is not believed.
      expect(await ipSeenBy(trusted('127.0.0.1,10.0.0.9').proxies, { 'X-Forwarded-For': '1.2.3.4, 10.0.0.9' })).toBe('10.0.0.9');
    });

    it('from an untrusted peer request.ip is the connection address', async () => {
      expect(await ipSeenBy(trusted('10.0.0.1').proxies, { 'X-Forwarded-For': '1.2.3.4' })).toBe('127.0.0.1');
      await server?.close();
      expect(await ipSeenBy(trusted('').proxies, { 'X-Forwarded-For': '1.2.3.4' })).toBe('127.0.0.1');
    });
  });
});
