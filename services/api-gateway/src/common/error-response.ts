import { HttpException } from '@nestjs/common';
import { STATUS_CODES } from 'node:http';
import { AppException, ERROR_MESSAGES, type ErrorCode } from './app-exception';

/** Body of every error response: {"status","error","message","requestId"}. */
export interface ErrorResponse {
  status: number;
  error: string;
  message: string;
  requestId: string;
}

export interface MappedError {
  body: ErrorResponse;
  retryAfterSeconds?: number;
  // True for errors nobody planned for (bugs); they are logged with the stack trace.
  unexpected: boolean;
}

// Errors raised by Nest or Fastify (unknown path, body too large, ...) get the catalog code and message.
const CATALOG_BY_STATUS: Record<number, { code: ErrorCode; message: string }> = {
  400: { code: 'VALIDATION_ERROR', message: ERROR_MESSAGES.badRequest },
  401: { code: 'UNAUTHORIZED', message: ERROR_MESSAGES.unauthorized },
  403: { code: 'FORBIDDEN', message: ERROR_MESSAGES.forbidden },
  404: { code: 'NOT_FOUND', message: ERROR_MESSAGES.notFound },
  405: { code: 'METHOD_NOT_ALLOWED', message: ERROR_MESSAGES.methodNotAllowed },
  413: { code: 'PAYLOAD_TOO_LARGE', message: ERROR_MESSAGES.payloadTooLarge },
  429: { code: 'TOO_MANY_REQUESTS', message: ERROR_MESSAGES.tooManyRequests },
  431: { code: 'REQUEST_HEADER_FIELDS_TOO_LARGE', message: ERROR_MESSAGES.headersTooLarge },
  502: { code: 'BAD_GATEWAY', message: ERROR_MESSAGES.badGateway },
  503: { code: 'SERVICE_UNAVAILABLE', message: ERROR_MESSAGES.serviceUnavailable },
  504: { code: 'GATEWAY_TIMEOUT', message: ERROR_MESSAGES.gatewayTimeout },
};

/** HTTP status name in UPPER_SNAKE_CASE, e.g. 415 -> UNSUPPORTED_MEDIA_TYPE. */
export function codeFromStatusName(status: number): string {
  const name = STATUS_CODES[status] ?? 'Client Error';
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function internalError(requestId: string): MappedError {
  return { body: { status: 500, error: 'INTERNAL_ERROR', message: ERROR_MESSAGES.internal, requestId }, unexpected: true };
}

function fromStatus(status: number, requestId: string): MappedError {
  const known = CATALOG_BY_STATUS[status];
  if (known) {
    return { body: { status, error: known.code, message: known.message, requestId }, unexpected: false };
  }
  if (status >= 400 && status < 500) {
    // Other client errors: code and message from the status name (Z6), never the internal message.
    return {
      body: { status, error: codeFromStatusName(status), message: STATUS_CODES[status] ?? 'Client error', requestId },
      unexpected: false,
    };
  }
  return internalError(requestId);
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
    return fromStatus(exception.getStatus(), requestId);
  }
  return internalError(requestId);
}
