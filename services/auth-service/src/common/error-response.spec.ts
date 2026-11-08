import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { AppException } from './app-exception';
import { mapError } from './error-response';

describe('mapError', () => {
  it('maps AppException with its code and Retry-After', () => {
    const result = mapError(new AppException(429, 'TOO_MANY_ATTEMPTS', 'Account is locked', 120), 'r1');
    expect(result).toEqual({
      body: { status: 429, error: 'TOO_MANY_ATTEMPTS', message: 'Account is locked', requestId: 'r1' },
      retryAfterSeconds: 120,
      unexpected: false,
    });
  });

  it('maps Nest 404 to NOT_FOUND', () => {
    expect(mapError(new NotFoundException('Cannot GET /missing'), 'r2').body).toEqual({
      status: 404,
      error: 'NOT_FOUND',
      message: 'Cannot GET /missing',
      requestId: 'r2',
    });
  });

  it('joins ValidationPipe messages into one VALIDATION_ERROR message', () => {
    const exception = new BadRequestException(['property roles should not exist', 'email must be an email']);
    expect(mapError(exception, 'r3').body).toEqual({
      status: 400,
      error: 'VALIDATION_ERROR',
      message: 'property roles should not exist; email must be an email',
      requestId: 'r3',
    });
  });

  it('maps other client errors from Fastify to a code from the status name (Z6)', () => {
    expect(mapError(new HttpException('Request body is too large', 413), 'r4').body).toMatchObject({
      status: 413,
      error: 'PAYLOAD_TOO_LARGE',
    });
    expect(mapError(new HttpException('Unsupported Media Type', 415), 'r4').body).toMatchObject({
      status: 415,
      error: 'UNSUPPORTED_MEDIA_TYPE',
    });
    expect(mapError(new HttpException('Method not allowed', 405), 'r4').body).toMatchObject({
      status: 405,
      error: 'METHOD_NOT_ALLOWED',
    });
  });

  it('maps 503 to SERVICE_UNAVAILABLE', () => {
    expect(mapError(new ServiceUnavailableException('User Service unavailable'), 'r5').body.error).toBe(
      'SERVICE_UNAVAILABLE',
    );
  });

  it('hides details of unknown errors behind 500 INTERNAL_ERROR', () => {
    const result = mapError(new Error('password column missing at db.ts:42'), 'r6');
    expect(result.body).toEqual({
      status: 500,
      error: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId: 'r6',
    });
    expect(result.unexpected).toBe(true);
  });
});
