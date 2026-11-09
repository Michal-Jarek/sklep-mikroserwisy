/** Error codes of the team error format (stage 2 guidelines, decision 8). */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_CREDENTIALS'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'EMAIL_TAKEN'
  | 'TOO_MANY_REQUESTS'
  | 'TOO_MANY_ATTEMPTS'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE'
  // Other 4xx raised by Fastify: code from the HTTP status name (Z6).
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE';

/**
 * Error with an explicit status and code, e.g.
 * throw new AppException(409, 'EMAIL_TAKEN', 'Email is already registered').
 * For 429 pass retryAfterSeconds; it is sent as the Retry-After header.
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
