import { jest } from '@jest/globals';
import { Body, Controller, Get, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { IsEmail } from 'class-validator';
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
    const response = await postJson(JSON.stringify({ email: 'x'.repeat(1024 * 1024) }));
    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({ status: 413, error: 'PAYLOAD_TOO_LARGE' });
    expect(response.body.requestId).toBe(response.headers.get('x-request-id'));
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
