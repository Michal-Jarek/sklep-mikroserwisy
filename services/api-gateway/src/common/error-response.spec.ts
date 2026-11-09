import { HttpException, NotFoundException } from '@nestjs/common';
import { AppException, ERROR_MESSAGES } from './app-exception';
import { mapError } from './error-response';

describe('mapError', () => {
  it('keeps the code, message and Retry-After of AppException', () => {
    expect(mapError(new AppException(429, 'TOO_MANY_REQUESTS', ERROR_MESSAGES.tooManyRequests, 7), 'r1')).toEqual({
      body: { status: 429, error: 'TOO_MANY_REQUESTS', message: 'Too many requests, try again later', requestId: 'r1' },
      retryAfterSeconds: 7,
      unexpected: false,
    });
  });

  it('replaces the Nest 404 message ("Cannot GET /x") with the catalog message', () => {
    expect(mapError(new NotFoundException('Cannot GET /x'), 'r2').body).toEqual({
      status: 404,
      error: 'NOT_FOUND',
      message: 'Not found',
      requestId: 'r2',
    });
  });

  it.each([
    [400, 'VALIDATION_ERROR', 'Bad request'],
    [405, 'METHOD_NOT_ALLOWED', 'Method not allowed'],
    [413, 'PAYLOAD_TOO_LARGE', 'Request body is too large'],
    [431, 'REQUEST_HEADER_FIELDS_TOO_LARGE', 'Request headers are too large'],
    [502, 'BAD_GATEWAY', 'Service is not reachable'],
    [503, 'SERVICE_UNAVAILABLE', 'Service is unavailable, try again later'],
    [504, 'GATEWAY_TIMEOUT', 'Service did not respond in time'],
  ])('maps HttpException %i to %s with the catalog message', (status, code, message) => {
    expect(mapError(new HttpException('internal', status), 'r3').body).toEqual({ status, error: code, message, requestId: 'r3' });
  });

  it('maps other 4xx to a code from the status name', () => {
    expect(mapError(new HttpException('internal', 415), 'r4').body).toEqual({
      status: 415,
      error: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'Unsupported Media Type',
      requestId: 'r4',
    });
  });

  it('hides unknown errors and HttpException 500 behind 500 INTERNAL_ERROR', () => {
    for (const exception of [new Error('password column missing at db.ts:42'), new HttpException('boom', 500), 'text']) {
      const result = mapError(exception, 'r5');
      expect(result.body).toEqual({ status: 500, error: 'INTERNAL_ERROR', message: 'Internal server error', requestId: 'r5' });
      expect(result.unexpected).toBe(true);
    }
  });
});
