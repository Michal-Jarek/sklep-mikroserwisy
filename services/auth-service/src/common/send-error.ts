import type { FastifyReply } from 'fastify';
import type { Logger } from 'pino';
import { mapError } from './error-response';

/** Sends an error in the team format. Used by the global exception filter (Nest also routes Fastify errors there). */
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
  void reply.status(body.status).send(body);
}
