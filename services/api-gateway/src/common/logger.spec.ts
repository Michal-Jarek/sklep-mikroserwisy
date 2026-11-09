import type { IncomingMessage } from 'node:http';
import { pino } from 'pino';
import { GATEWAY_PREFIX, PATHS } from '../routes';
import { isConsulHealthCheck, REDACTED_PATHS, serializeError } from './logger';

function request(url: string, userAgent?: string): IncomingMessage {
  return { url, headers: userAgent === undefined ? {} : { 'user-agent': userAgent } } as IncomingMessage;
}

describe('logger', () => {
  it('skips only the request log lines of Consul health checks', () => {
    expect(isConsulHealthCheck(request(PATHS.healthReady, 'Consul Health Check'))).toBe(true);
    expect(isConsulHealthCheck(request(`${PATHS.healthLive}?x=1`, 'Consul Health Check'))).toBe(true);
    expect(isConsulHealthCheck(request(PATHS.healthReady, 'curl/8.7.1'))).toBe(false);
    expect(isConsulHealthCheck(request(PATHS.healthReady))).toBe(false);
  });

  it('logs other paths even with the Consul User-Agent', () => {
    expect(isConsulHealthCheck(request(`${GATEWAY_PREFIX}/products`, 'Consul Health Check'))).toBe(false);
    expect(isConsulHealthCheck(request(`${PATHS.healthReady}/x`, 'Consul Health Check'))).toBe(false);
  });

  it('uses originalUrl when the middleware layer has already cut req.url', () => {
    const cut = (originalUrl: string): IncomingMessage => Object.assign(request('/', 'Consul Health Check'), { originalUrl });
    expect(isConsulHealthCheck(cut(PATHS.healthReady))).toBe(true);
    expect(isConsulHealthCheck(cut(`${GATEWAY_PREFIX}/products`))).toBe(false);
  });

  it('redacts credentials in request and response headers', () => {
    for (const side of ['req', 'res']) {
      expect(REDACTED_PATHS).toEqual(
        expect.arrayContaining([`${side}.headers.authorization`, `${side}.headers.cookie`, `${side}.headers["set-cookie"]`]),
      );
    }
  });

  it('redacts Proxy-Authorization of the client (N4)', () => {
    const lines: string[] = [];
    const logger = pino({ redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' } }, { write: (line: string) => lines.push(line) });
    logger.info({ req: { headers: { 'proxy-authorization': 'Basic c2VrcmV0OnRlc3Q=', accept: '*/*' } } }, 'x');
    expect(JSON.parse(lines[0]).req.headers).toEqual({ 'proxy-authorization': '[REDACTED]', accept: '*/*' });
  });

  it('serializeError keeps other values (already serialized errors with their stack, null) unchanged', () => {
    const serialized = pino.stdSerializers.err(new TypeError('boom'));
    expect(serializeError(serialized)).toBe(serialized);
    expect(serializeError(null)).toBeNull();
    expect(serializeError('text')).toBe('text');
  });
});
