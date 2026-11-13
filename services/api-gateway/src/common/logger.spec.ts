import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { pinoHttp, type Options } from 'pino-http';
import { GATEWAY_PREFIX, PATHS } from '../routes';
import { isConsulHealthCheck, loggerModuleParams, REDACTED_PATHS, serializeError, serializeRequest } from './logger';

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

  it('logs the request path and the Referer without the query string, no query and params (L7, Z12)', async () => {
    const lines: string[] = [];
    const logger = pino({ redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' } }, { write: (line: string) => lines.push(line) });
    const httpLogger = pinoHttp(loggerModuleParams(logger).pinoHttp as Options);
    const server = createServer((req, res) => {
      // As in the Gateway: the middleware layer (middie) cuts req.url before the request logger runs and
      // originalUrl keeps the full target, so the logged path comes from originalUrl (req.url is only "/").
      Object.assign(req, { originalUrl: req.url, url: '/' });
      httpLogger(req, res);
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const email = 'jan.kowalski6b@example.com';
    try {
      const { port } = server.address() as AddressInfo;
      await (
        await fetch(`http://127.0.0.1:${port}${GATEWAY_PREFIX}/products?q=${email}&page=0`, {
          headers: { Authorization: 'Bearer abc.def.ghi', Referer: `http://127.0.0.1:8090/?q=${email}` },
        })
      ).text();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    const line = lines.find((entry) => entry.includes('request completed'));
    expect(line).toBeDefined();
    const req = JSON.parse(line as string).req;
    expect(req.url).toBe(`${GATEWAY_PREFIX}/products`);
    expect(req.headers.referer).toBe('http://127.0.0.1:8090/');
    expect(req).not.toHaveProperty('query');
    expect(req).not.toHaveProperty('params');
    expect(req.method).toBe('GET');
    expect(req.remoteAddress).toBe('127.0.0.1');
    expect(typeof req.remotePort).toBe('number');
    expect(req.headers.authorization).toBe('[REDACTED]');
    expect(line).not.toContain(email);
    expect(line).not.toContain('abc.def.ghi');
  });

  it('serializeRequest cuts the query of Referer in a copy of the headers, the request stays unchanged (Z12)', () => {
    const headers = { referer: 'http://127.0.0.1:8090/login?returnTo=%2Fadmin%2Fproducts%3Fq%3Da%40b.pl', accept: '*/*' };
    const req = { id: 'rid-1', method: 'GET', url: '/api/v1/auth/refresh', headers };

    expect(serializeRequest(req).headers).toEqual({ referer: 'http://127.0.0.1:8090/login', accept: '*/*' });
    expect(headers.referer).toBe('http://127.0.0.1:8090/login?returnTo=%2Fadmin%2Fproducts%3Fq%3Da%40b.pl');
    expect(serializeRequest({ ...req, headers: { accept: '*/*' } }).headers).toEqual({ accept: '*/*' });
  });
});
