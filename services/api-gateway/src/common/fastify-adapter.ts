import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingMessage } from 'node:http';
import type { Logger } from 'pino';
import { ERROR_MESSAGES } from './app-exception';
import { createClientErrorHandler } from './client-error';
import type { ErrorResponse } from './error-response';
import { resolveRequestId } from './request-id';

// Request body limit (decision 10): 1 MiB; larger -> 413 PAYLOAD_TOO_LARGE.
export const BODY_LIMIT_BYTES = 1_048_576;

// Headers and body of a request must arrive within 30 s, otherwise 408 REQUEST_TIMEOUT (Z22): the Gateway is the
// first hop, a slow client may not hold a connection and its buffer. Node uses the smaller of headersTimeout and
// requestTimeout for the whole request (default headersTimeout 60 s) and checks every connectionsCheckingInterval
// (default 30 s), so both are set too: the 408 comes 30-31 s after the request started.
const REQUEST_TIMEOUT_MS = 30_000;
const CONNECTIONS_CHECKING_INTERVAL_MS = 1_000;

/**
 * Fastify for the Gateway:
 * - request id and response headers in an onRequest hook, so they are on every response, also 404
 *   and errors raised by Fastify itself (Nest routes those errors to the global exception filter);
 * - X-Gateway-Instance-Id only; X-Instance-Id comes from the services behind the Gateway (decision 19);
 * - trustProxy only for the direct peer (hop 0) listed in TRUSTED_PROXIES (stage 6, guidelines 3.3): from such a peer
 *   (the frontend nginx) request.ip is the last X-Forwarded-For entry, from anyone else the connection address;
 *   request.ip keys the rate limits and is the X-Forwarded-For for the services (request.hostname and
 *   request.protocol, which would follow X-Forwarded-Host/-Proto, are not used);
 * - clientErrorHandler: malformed requests, too large headers and requests not received in time in the
 *   team format (decision 23, Z22);
 * - frameworkErrors: a URL the router cannot decode (e.g. /api/v1/products/%zz) is rejected before any
 *   hook runs; it gets 400 "Invalid request path" in the team format with the Gateway headers (decision 8).
 */
export function createFastifyAdapter(
  instanceId: string,
  logger: Pick<Logger, 'info'>,
  isTrustedProxy: (address: string) => boolean,
): FastifyAdapter {
  const adapter = new FastifyAdapter({
    trustProxy: (address: string, hop: number) => hop === 0 && isTrustedProxy(address),
    genReqId: (req: IncomingMessage) => resolveRequestId(req.headers['x-request-id']),
    bodyLimit: BODY_LIMIT_BYTES,
    requestTimeout: REQUEST_TIMEOUT_MS,
    http: { headersTimeout: REQUEST_TIMEOUT_MS, connectionsCheckingInterval: CONNECTIONS_CHECKING_INTERVAL_MS },
    clientErrorHandler: createClientErrorHandler(instanceId, logger),
    frameworkErrors: (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
      const body: ErrorResponse = { status: 400, error: 'VALIDATION_ERROR', message: ERROR_MESSAGES.invalidPath, requestId: request.id };
      logger.info({ requestId: request.id, statusCode: 400, reason: error.code }, 'Request with a malformed URL rejected');
      void reply.code(400).header('X-Request-Id', request.id).header('X-Gateway-Instance-Id', instanceId).send(body);
    },
  });
  adapter.getInstance().addHook('onRequest', (request, reply, done) => {
    void reply.header('X-Request-Id', request.id);
    void reply.header('X-Gateway-Instance-Id', instanceId);
    done();
  });
  return adapter;
}
