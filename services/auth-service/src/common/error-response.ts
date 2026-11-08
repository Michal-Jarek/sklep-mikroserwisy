import { HttpException } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { STATUS_CODES } from 'node:http';
import { AppException, ErrorCode } from './app-exception';

/** Body of every error response: {"status","error","message","requestId"}. */
export class ErrorResponse {
  @ApiProperty({ example: 404 })
  status: number;

  @ApiProperty({ example: 'NOT_FOUND' })
  error: string;

  @ApiProperty({ example: 'Cannot GET /missing' })
  message: string;

  @ApiProperty({ example: '0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e' })
  requestId: string;
}

export interface MappedError {
  body: ErrorResponse;
  retryAfterSeconds?: number;
  // True for errors nobody planned for (bugs); they are logged with the stack trace.
  unexpected: boolean;
}

const CODE_BY_STATUS: Record<number, ErrorCode> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  404: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'TOO_MANY_REQUESTS',
  503: 'SERVICE_UNAVAILABLE',
};

const INTERNAL_MESSAGE = 'Internal server error';

function httpExceptionMessage(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') {
    return response;
  }
  const message = (response as { message?: unknown }).message;
  if (Array.isArray(message)) {
    // ValidationPipe returns one message per failed constraint.
    return message.join('; ');
  }
  return typeof message === 'string' ? message : exception.message;
}

/** HTTP status name in UPPER_SNAKE_CASE, e.g. 405 -> METHOD_NOT_ALLOWED. */
export function codeFromStatusName(status: number): string {
  const name = STATUS_CODES[status] ?? 'Client Error';
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function fromStatus(status: number, message: string, requestId: string): MappedError {
  const code = CODE_BY_STATUS[status];
  if (code) {
    return { body: { status, error: code, message, requestId }, unexpected: false };
  }
  if (status >= 400 && status < 500) {
    // Other client errors raised by Fastify, which Nest turns into HttpException (Z6).
    return { body: { status, error: codeFromStatusName(status), message, requestId }, unexpected: false };
  }
  return { body: { status: 500, error: 'INTERNAL_ERROR', message: INTERNAL_MESSAGE, requestId }, unexpected: true };
}

/** Maps any thrown value to the team error format. Never exposes a stack trace or internal details. */
export function mapError(exception: unknown, requestId: string): MappedError {
  if (exception instanceof AppException) {
    return {
      body: { status: exception.status, error: exception.code, message: exception.message, requestId },
      retryAfterSeconds: exception.retryAfterSeconds,
      unexpected: false,
    };
  }
  if (exception instanceof HttpException) {
    return fromStatus(exception.getStatus(), httpExceptionMessage(exception), requestId);
  }
  return { body: { status: 500, error: 'INTERNAL_ERROR', message: INTERNAL_MESSAGE, requestId }, unexpected: true };
}
