import { jest } from '@jest/globals';
import { Body, Controller, Get, HttpException, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { connect } from 'node:net';
import { AppException, ERROR_MESSAGES } from './common/app-exception';
import { BODY_LIMIT_BYTES, createFastifyAdapter } from './common/fastify-adapter';
import { GatewayConfigState } from './config/gateway-config-state.service';
import { HealthController } from './health/health.controller';
import { GATEWAY_PREFIX, PATHS } from './routes';
import { setupApp } from './setup-app';

// Routes of the test controller below, not routes of the Gateway (those are in routes.ts).
const ECHO = 'echo';
const BOOM = 'boom';
const LIMITED = 'limited';
const DENIED = 'denied';
const TEAPOT = 'teapot';
const MISSING = 'missing';

const INSTANCE_ID = 'api-gateway-test';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Test-only controller: shows what a handler receives as the body and throws the errors to map.
@Controller(ECHO)
class EchoController {
  @Post()
  echo(@Body() body: unknown): { isBuffer: boolean; length: number; base64: string } {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
    return { isBuffer: Buffer.isBuffer(body), length: buffer.length, base64: buffer.toString('base64') };
  }

  @Get(BOOM)
  boom(): never {
    throw new Error('secret detail from db.ts:42');
  }

  @Get(LIMITED)
  limited(): never {
    throw new AppException(429, 'TOO_MANY_REQUESTS', ERROR_MESSAGES.tooManyRequests, 42);
  }

  @Get(DENIED)
  denied(): never {
    throw new AppException(401, 'UNAUTHORIZED', ERROR_MESSAGES.unauthorized);
  }

  @Get(TEAPOT)
  teapot(): never {
    throw new HttpException('internal text that must not leak', 418);
  }
}

interface HttpResult {
  status: number;
  headers: Headers;
  text: string;
  body: Record<string, unknown>;
}

/** Sends raw bytes and returns the raw HTTP response (the server closes the connection). */
function rawRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(payload));
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function rawBody(response: string): Record<string, unknown> {
  return JSON.parse(response.slice(response.indexOf('\r\n\r\n') + 4)) as Record<string, unknown>;
}

// A real HTTP server on a random port (Fastify inject needs an ESM-only package that Jest cannot load on Node 22).
describe('HTTP layer (headers, body parser, error format, health)', () => {
  let app: NestFastifyApplication;
  let baseUrl: string;
  let port: number;
  let configLoaded = false;
  const logger = { info: jest.fn(), error: jest.fn() };

  async function request(path: string, init: RequestInit = {}): Promise<HttpResult> {
    const response = await fetch(`${baseUrl}${path}`, init);
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: JSON.parse(text) as Record<string, unknown> };
  }

  function post(body: string | Uint8Array<ArrayBuffer>, contentType?: string): Promise<HttpResult> {
    return request(`/${ECHO}`, { method: 'POST', headers: contentType ? { 'content-type': contentType } : {}, body });
  }

  beforeAll(async () => {
    const configState = { current: () => (configLoaded ? {} : null) };
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController, EchoController],
      providers: [{ provide: GatewayConfigState, useValue: configState }],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      createFastifyAdapter(INSTANCE_ID, logger),
      { logger: false, bodyParser: false },
    );
    await setupApp(app, logger);
    await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = await app.getUrl();
    port = Number(new URL(baseUrl).port);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('health', () => {
    it('live is UP with the Gateway headers and without X-Instance-Id', async () => {
      const response = await request(PATHS.healthLive);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'UP' });
      expect(response.headers.get('x-request-id')).toMatch(UUID_V4);
      expect(response.headers.get('x-gateway-instance-id')).toBe(INSTANCE_ID);
      expect(response.headers.get('x-instance-id')).toBeNull();
    });

    it('ready is 503 SERVICE_UNAVAILABLE until the configuration is loaded, then 200', async () => {
      configLoaded = false;
      const notReady = await request(PATHS.healthReady);
      expect(notReady.status).toBe(503);
      expect(notReady.body).toEqual({
        status: 503,
        error: 'SERVICE_UNAVAILABLE',
        message: 'Service is unavailable, try again later',
        requestId: notReady.headers.get('x-request-id'),
      });

      configLoaded = true;
      const ready = await request(PATHS.healthReady);
      expect(ready.status).toBe(200);
      expect(ready.body).toEqual({ status: 'UP' });
    });
  });

  describe('headers', () => {
    it('keeps a valid X-Request-Id and replaces an invalid one', async () => {
      expect((await request(PATHS.healthLive, { headers: { 'x-request-id': 'k11-test' } })).headers.get('x-request-id')).toBe('k11-test');
      expect((await request(PATHS.healthLive, { headers: { 'x-request-id': 'zly id!' } })).headers.get('x-request-id')).toMatch(UUID_V4);
    });

    it('sets the helmet headers with the API content security policy, without X-Powered-By and Server', async () => {
      for (const path of [PATHS.healthLive, `/${MISSING}`]) {
        const { headers } = await request(path);
        expect(headers.get('content-security-policy')).toBe("default-src 'none';frame-ancestors 'none'");
        expect(headers.get('x-content-type-options')).toBe('nosniff');
        expect(headers.get('x-frame-options')).toBe('SAMEORIGIN');
        expect(headers.get('referrer-policy')).toBe('no-referrer');
        expect(headers.get('x-powered-by')).toBeNull();
        expect(headers.get('server')).toBeNull();
      }
    });
  });

  describe('errors', () => {
    it('answers 404 NOT_FOUND "Not found" for unknown paths, also under the public prefix (proxy comes later)', async () => {
      for (const path of [`/${MISSING}`, GATEWAY_PREFIX, `${GATEWAY_PREFIX}/${MISSING}`, `${GATEWAY_PREFIX}/products/p1?x=1`]) {
        const response = await request(path, { headers: { 'x-request-id': 'req-404' } });
        expect(response.status).toBe(404);
        expect(response.body).toEqual({ status: 404, error: 'NOT_FOUND', message: 'Not found', requestId: 'req-404' });
        expect(response.headers.get('x-gateway-instance-id')).toBe(INSTANCE_ID);
      }
      expect((await request(`/${MISSING}`, { method: 'PROPFIND' })).status).toBe(404);
    });

    it('hides unknown errors behind 500 INTERNAL_ERROR and logs them', async () => {
      const response = await request(`/${ECHO}/${BOOM}`);
      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        status: 500,
        error: 'INTERNAL_ERROR',
        message: 'Internal server error',
        requestId: response.headers.get('x-request-id'),
      });
      expect(response.text).not.toContain('secret');
      expect(response.text).not.toContain('stack');
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('sends 401 with WWW-Authenticate: Bearer', async () => {
      const response = await request(`/${ECHO}/${DENIED}`);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
      expect(response.body).toMatchObject({ error: 'UNAUTHORIZED', message: 'Missing or invalid access token' });
    });

    it('sends 429 with Retry-After', async () => {
      const response = await request(`/${ECHO}/${LIMITED}`);
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('42');
      expect(response.body).toMatchObject({ error: 'TOO_MANY_REQUESTS', message: 'Too many requests, try again later' });
    });

    it('maps other client errors to a code from the status name, without the internal message', async () => {
      const response = await request(`/${ECHO}/${TEAPOT}`);
      expect(response.status).toBe(418);
      expect(response.body).toMatchObject({ error: 'I_M_A_TEAPOT', message: "I'm a Teapot" });
      expect(response.text).not.toContain('internal text');
    });
  });

  describe('request body: every content type as a Buffer, byte for byte', () => {
    it.each([
      ['application/json; charset=utf-8', '{ "productId" :"p1",  "quantity":2 }'],
      ['application/json', '{zly json'],
      ['application/x-www-form-urlencoded', 'a=1&b=%20'],
      ['text/plain', 'non-ASCII \u017c\u00f3\u0142w\r\n'],
      ['application/xml', '<x/>'],
    ])('%s', async (contentType, payload) => {
      const response = await post(payload, contentType);
      expect(response.status).toBe(201);
      expect(response.body.isBuffer).toBe(true);
      expect(Buffer.from(response.body.base64 as string, 'base64').toString('utf8')).toBe(payload);
    });

    it('accepts a body without Content-Type', async () => {
      const response = await post(new Uint8Array([0, 1, 2, 255]));
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ isBuffer: true, base64: Buffer.from([0, 1, 2, 255]).toString('base64') });
    });

    it('accepts exactly 1 MiB and rejects one byte more with 413 PAYLOAD_TOO_LARGE', async () => {
      const ok = await post('a'.repeat(BODY_LIMIT_BYTES), 'text/plain');
      expect(ok.status).toBe(201);
      expect(ok.body.length).toBe(1_048_576);

      // Only the headers: Fastify answers from Content-Length and closes the connection, so a client
      // still sending the body could get EPIPE before reading the answer (curl in K18 sends it whole).
      const response = await rawRequest(
        port,
        `POST /${ECHO} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${BODY_LIMIT_BYTES + 1}\r\n\r\n`,
      );
      expect(response.startsWith('HTTP/1.1 413 ')).toBe(true);
      const body = rawBody(response);
      expect(body).toEqual({
        status: 413,
        error: 'PAYLOAD_TOO_LARGE',
        message: 'Request body is too large',
        requestId: expect.stringMatching(UUID_V4),
      });
      expect(response.toLowerCase()).toContain(`\r\nx-request-id: ${body.requestId as string}\r\n`);
      expect(response.toLowerCase()).toContain(`\r\nx-gateway-instance-id: ${INSTANCE_ID}\r\n`);
    });
  });

  describe('malformed requests (clientErrorHandler)', () => {
    it('answers 431 REQUEST_HEADER_FIELDS_TOO_LARGE for headers over 16 KB and closes the connection', async () => {
      const response = await rawRequest(port, `GET ${PATHS.healthLive} HTTP/1.1\r\nHost: x\r\nX-Big: ${'a'.repeat(20_000)}\r\n\r\n`);
      expect(response.startsWith('HTTP/1.1 431 ')).toBe(true);
      expect(response).toMatch(/\r\nConnection: close\r\n/);
      expect(response).toContain(`\r\nX-Gateway-Instance-Id: ${INSTANCE_ID}\r\n`);
      const body = rawBody(response);
      expect(body).toEqual({
        status: 431,
        error: 'REQUEST_HEADER_FIELDS_TOO_LARGE',
        message: 'Request headers are too large',
        requestId: expect.stringMatching(UUID_V4),
      });
      expect(response).toContain(`\r\nX-Request-Id: ${body.requestId as string}\r\n`);
    });

    it('answers 400 VALIDATION_ERROR "Bad request" for a request Node cannot parse', async () => {
      const response = await rawRequest(port, 'NOT A REQUEST\r\n\r\n');
      expect(response.startsWith('HTTP/1.1 400 ')).toBe(true);
      expect(response).toContain('Content-Type: application/json');
      expect(rawBody(response)).toMatchObject({ status: 400, error: 'VALIDATION_ERROR', message: 'Bad request' });
    });
  });
});
