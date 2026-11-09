/** Error codes of the Gateway (decision 24; code from the HTTP status name, stage 2 Z6). */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'REQUEST_TIMEOUT'
  | 'PAYLOAD_TOO_LARGE'
  | 'TOO_MANY_REQUESTS'
  | 'REQUEST_HEADER_FIELDS_TOO_LARGE'
  | 'INTERNAL_ERROR'
  | 'BAD_GATEWAY'
  | 'SERVICE_UNAVAILABLE'
  | 'GATEWAY_TIMEOUT';

/** Exact "message" texts of the Gateway errors (guidelines 3.5). */
export const ERROR_MESSAGES = {
  invalidPath: 'Invalid request path',
  badRequest: 'Bad request',
  unauthorized: 'Missing or invalid access token',
  forbidden: 'Insufficient role',
  notFound: 'Not found',
  methodNotAllowed: 'Method not allowed',
  requestTimeout: 'Request was not received in time',
  payloadTooLarge: 'Request body is too large',
  tooManyRequests: 'Too many requests, try again later',
  headersTooLarge: 'Request headers are too large',
  badGateway: 'Service is not reachable',
  serviceUnavailable: 'Service is unavailable, try again later',
  gatewayTimeout: 'Service did not respond in time',
  internal: 'Internal server error',
} as const;

/**
 * Error with an explicit status and code, e.g.
 * throw new AppException(404, 'NOT_FOUND', ERROR_MESSAGES.notFound).
 * For 429 pass retryAfterSeconds; it is sent as the Retry-After header.
 * Every 401 gets WWW-Authenticate: Bearer (set by sendError).
 */
export class AppException extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'AppException';
  }
}
