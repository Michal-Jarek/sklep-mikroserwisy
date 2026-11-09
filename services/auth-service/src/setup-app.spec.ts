import { jest } from '@jest/globals';
import { Body, Controller, Get, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { IsEmail } from 'class-validator';
import { connect } from 'node:net';
import { AppException } from './common/app-exception';
import { createFastifyAdapter } from './common/fastify-adapter';
import { createOpenApiDocument, setupApp } from './setup-app';

// Routes of the test controller below, not routes of the service (those are in routes.ts).
const SAMPLE = 'sample';
const BOOM = 'boom';
const LOCKED = 'locked';
const MISSING = 'missing';

// Controller and DTO only for this test: the real endpoints with bodies come in later tasks.
class SampleDto {
  @IsEmail()
  email: string;
}

@Controller(SAMPLE)
class SampleController {
  @Post()
  create(@Body() body: SampleDto): SampleDto {
    return body;
  }

  @Get(BOOM)
  boom(): never {
    throw new Error('secret detail from db.ts:42');
  }

  @Get(LOCKED)
  locked(): never {
    throw new AppException(429, 'TOO_MANY_ATTEMPTS', 'Account is temporarily locked', 60);
  }
}

interface HttpResult {
  status: number;
  headers: Headers;
  text: string;
  body: Record<string, unknown>;
}

/** Sends raw bytes and returns everything the server wrote until it closed the connection. */
function rawRequest(url: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(Number(new URL(url).port), '127.0.0.1', () => socket.write(payload));
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

// A real HTTP server on a random port (Fastify inject needs an ESM-only package that Jest cannot load on Node 22).
describe('HTTP layer (headers, validation, error format)', () => {
  let app: NestFastifyApplication;
  let baseUrl: string;
  const logger = { error: jest.fn() };

  async function request(path: string, init: RequestInit = {}): Promise<HttpResult> {
    const response = await fetch(`${baseUrl}${path}`, init);
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: JSON.parse(text) as Record<string, unknown> };
  }

  function postJson(payload: string): Promise<HttpResult> {
    return request(`/${SAMPLE}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [SampleController] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter('auth-service-test'), {
      logger: false,
    });
    setupApp(app, logger);
    await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it('accepts a valid body', async () => {
    const response = await postJson('{"email":"a@example.com"}');
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ email: 'a@example.com' });
  });

  it('returns 400 VALIDATION_ERROR for invalid JSON, with both headers and the same requestId', async () => {
    const response = await postJson('{zly json');
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      status: 400,
      error: 'VALIDATION_ERROR',
      message: expect.any(String),
      requestId: response.headers.get('x-request-id'),
    });
    expect(response.headers.get('x-instance-id')).toBe('auth-service-test');
    expect(response.text).not.toContain('stack');
  });

  it('rejects unknown fields with 400 VALIDATION_ERROR', async () => {
    const response = await postJson('{"email":"a@example.com","roles":["ADMIN"]}');
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: 'VALIDATION_ERROR',
      message: expect.stringContaining('property roles should not exist'),
    });
  });

  it('rejects invalid field values with 400 VALIDATION_ERROR', async () => {
    const response = await postJson('{"email":"not-an-email"}');
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'VALIDATION_ERROR' });
  });

  it('returns 404 NOT_FOUND for an unknown path and keeps a valid X-Request-Id', async () => {
    const response = await request(`/${MISSING}`, { headers: { 'x-request-id': 'req-404' } });
    expect(response.status).toBe(404);
    expect(response.headers.get('x-request-id')).toBe('req-404');
    expect(response.headers.get('x-instance-id')).toBe('auth-service-test');
    expect(response.body).toEqual({
      status: 404,
      error: 'NOT_FOUND',
      message: `Cannot GET /${MISSING}`,
      requestId: 'req-404',
    });
  });

  it('hides unknown errors behind 500 INTERNAL_ERROR and logs them', async () => {
    const response = await request(`/${SAMPLE}/${BOOM}`);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      status: 500,
      error: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId: response.headers.get('x-request-id'),
    });
    expect(response.text).not.toContain('secret');
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('returns 413 PAYLOAD_TOO_LARGE for a body over the 1 MiB limit (Z6)', async () => {
    // Only the headers: Fastify answers from Content-Length and closes the connection, so a client
    // still sending the body could get EPIPE before reading the answer (the test was flaky with fetch).
    const response = await rawRequest(
      baseUrl,
      `POST /${SAMPLE} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${1024 * 1024 + 1}\r\n\r\n`,
    );
    expect(response.startsWith('HTTP/1.1 413 ')).toBe(true);
    const body = JSON.parse(response.slice(response.indexOf('\r\n\r\n') + 4)) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 413, error: 'PAYLOAD_TOO_LARGE' });
    expect(response.toLowerCase()).toContain(`\r\nx-request-id: ${body.requestId as string}\r\n`);
  });

  it('returns 415 UNSUPPORTED_MEDIA_TYPE for a Content-Type without a parser (Z6)', async () => {
    const response = await request(`/${SAMPLE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/xml' },
      body: '<x/>',
    });
    expect(response.status).toBe(415);
    expect(response.body).toMatchObject({ status: 415, error: 'UNSUPPORTED_MEDIA_TYPE' });
  });

  it('sends Retry-After for AppException with retryAfterSeconds', async () => {
    const response = await request(`/${SAMPLE}/${LOCKED}`);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(response.body).toMatchObject({ error: 'TOO_MANY_ATTEMPTS' });
  });

  it('builds the OpenAPI document from the controllers', () => {
    expect(Object.keys(createOpenApiDocument(app).paths)).toContain(`/${SAMPLE}`);
  });
});
