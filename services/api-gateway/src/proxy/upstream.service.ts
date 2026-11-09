import type {} from '@fastify/reply-from';
import { Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { type Instance, ServiceDiscovery } from '../consul/service-discovery.service';
import { classifyUpstreamError, type UpstreamErrorKind } from './upstream-error';
import { buildUpstreamHeaders, filterResponseHeaders, type ForwardedFor, mergeVary } from './upstream-headers';

/** What is sent to the service (the first instance is chosen by the caller, step 9). */
export interface UpstreamRequest {
  // Canonical path without the public prefix and the raw query (decision 8).
  path: string;
  query: string;
  forwarded: ForwardedFor;
  // Response time limit: headersTimeout and bodyTimeout of undici (proxy.timeoutSeconds).
  timeoutMs: number;
}

/**
 * Outcome of forward(), known as soon as the service answered, the last attempt failed or the client left:
 * - response: the service response (any status, also 4xx/5xx) is being streamed to the client unchanged
 *   (upstream is already in the request log fields);
 * - unreachable / timeout / failed: nothing was sent yet, the caller answers 502 / 504 / 502;
 * - rejected: the request could not be built from what the client sent, nothing reached the service (400);
 * - aborted: the client closed the connection before the service answered (when it left before the
 *   request was sent, the service gets nothing); nothing can be sent.
 * upstream = ip:port of the last attempt.
 */
export type ForwardResult =
  | { kind: 'response'; statusCode: number; upstream: string }
  | { kind: UpstreamErrorKind | 'aborted'; upstream: string };

// Only these methods are retried, and only when there was no connection (decision 11).
const RETRIED_METHODS = new Set(['GET', 'HEAD']);

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

@Injectable()
export class UpstreamService {
  constructor(
    private readonly discovery: ServiceDiscovery,
    @InjectPinoLogger(UpstreamService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Step 10 of guidelines 3.4: the request to the instance chosen in step 9, through reply-from.
   * No connection -> the instance is evicted from the cached list; GET/HEAD get one immediate retry
   * on another instance from Consul (if there is one). No retry after a timeout or a 5xx response.
   */
  async forward(
    service: string,
    instance: Instance,
    request: FastifyRequest,
    reply: FastifyReply,
    target: UpstreamRequest,
  ): Promise<ForwardResult> {
    const first = await this.attempt(service, instance, request, reply, target);
    if (first.kind !== 'unreachable') {
      return first;
    }
    this.discovery.evict(service, instance);
    if (!RETRIED_METHODS.has(request.method)) {
      return first;
    }
    const next = await this.discovery.getInstance(service);
    if (!next || next.id === instance.id) {
      return first;
    }
    const second = await this.attempt(service, next, request, reply, target);
    if (second.kind === 'unreachable') {
      this.discovery.evict(service, next);
    }
    return second;
  }

  private attempt(
    service: string,
    instance: Instance,
    request: FastifyRequest,
    reply: FastifyReply,
    target: UpstreamRequest,
  ): Promise<ForwardResult> {
    const upstream = `${instance.address}:${instance.port}`;
    // reply-from would re-serialize a Buffer with a JSON type and drop "; charset=...": the body and its
    // type are passed explicitly (decision 10). Without a body (GET, HEAD, empty POST) nothing is passed.
    const body = Buffer.isBuffer(request.body)
      ? { body: request.body, contentType: request.headers['content-type'] ?? DEFAULT_CONTENT_TYPE }
      : {};
    return new Promise((resolve) => {
      // The client left during the earlier steps (limits, token, Consul, before a retry): its 'close' event is
      // gone and reply-from skips onResponse for an aborted request, so nothing would settle the promise.
      // The service is not called at all.
      if (reply.raw.destroyed) {
        resolve({ kind: 'aborted', upstream });
        return;
      }
      // A client that leaves before the answer: reply-from calls neither onResponse nor onError, so
      // without this the promise (and a half-open circuit waiting for its trial) would never settle.
      const onClose = (): void => resolve({ kind: 'aborted', upstream });
      reply.raw.once('close', onClose);
      reply.from(`http://${upstream}${target.path}`, {
        ...body,
        timeout: target.timeoutMs,
        // The raw query, unchanged (also when it is not valid percent-encoding).
        queryString: () => target.query,
        rewriteRequestHeaders: (_request, headers) => buildUpstreamHeaders(headers, target.forwarded),
        rewriteHeaders: (headers) => {
          // Gateway headers win (Z11), but Vary is merged: Vary: Origin of CORS must not hide the service one.
          const vary = mergeVary(reply.getHeader('vary'), headers.vary);
          if (vary !== undefined) {
            void reply.header('Vary', vary);
          }
          return filterResponseHeaders(headers, new Set(Object.keys(reply.getHeaders()))) as IncomingHttpHeaders;
        },
        // reply-from would retry GET after a 503 response (up to 10 times); retries are decided here.
        retryDelay: () => null,
        onResponse: (_request, _reply, response) => {
          reply.raw.off('close', onClose);
          // Before send: a short response can be finished (and its log line written) before forward() returns.
          this.logger.assign({ upstream });
          void reply.send(response.stream);
          resolve({ kind: 'response', statusCode: response.statusCode, upstream });
        },
        onError: (_reply, { error }) => {
          reply.raw.off('close', onClose);
          const { kind, code } = classifyUpstreamError(error);
          if (kind === 'rejected') {
            this.logger.info({ targetService: service, upstream, reason: code }, 'Request of the client could not be sent to the service');
          } else {
            this.logger.warn({ targetService: service, upstream, reason: code }, 'Request to the service failed');
          }
          resolve({ kind, upstream });
        },
      });
    });
  }
}
