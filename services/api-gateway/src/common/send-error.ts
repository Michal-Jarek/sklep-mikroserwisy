import type { FastifyReply } from 'fastify';
import type { Logger } from 'pino';
import { mapError } from './error-response';

/**
 * Sends an error in the team format: status, Retry-After (429), WWW-Authenticate: Bearer (401).
 * Used by the global exception filter and usable outside Nest (a Fastify route or hook).
 */
export function sendError(
  reply: FastifyReply,
  exception: unknown,
  requestId: string,
  logger: Pick<Logger, 'error'>,
): void {
  const { body, retryAfterSeconds, unexpected } = mapError(exception, requestId);
  if (unexpected) {
    logger.error({ err: exception, requestId }, 'Unhandled error');
  }
  if (retryAfterSeconds !== undefined) {
    void reply.header('Retry-After', String(retryAfterSeconds));
  }
  if (body.status === 401) {
    void reply.header('WWW-Authenticate', 'Bearer');
  }
  void reply.status(body.status).send(body);
}
