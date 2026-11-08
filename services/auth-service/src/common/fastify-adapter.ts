import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { IncomingMessage } from 'node:http';
import { resolveRequestId } from './request-id';

/**
 * Fastify with the request id and response headers set in an onRequest hook, so they are present
 * on every response, also 404 and errors raised by Fastify itself (invalid JSON, body too large).
 * Nest routes Fastify errors to the global exception filter, which keeps the team error format.
 *
 * trustProxy (decision 18): X-Forwarded-For is followed only through hops from loopback and private
 * networks (Docker networks, the Gateway from stage 3, a local run), so request.ip is the client
 * address behind them. A hop from any other address is the client itself.
 */
export function createFastifyAdapter(instanceId: string): FastifyAdapter {
  const adapter = new FastifyAdapter({
    genReqId: (req: IncomingMessage) => resolveRequestId(req.headers['x-request-id']),
    trustProxy: ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
  });
  adapter.getInstance().addHook('onRequest', (request, reply, done) => {
    void reply.header('X-Request-Id', request.id);
    void reply.header('X-Instance-Id', instanceId);
    done();
  });
  return adapter;
}
