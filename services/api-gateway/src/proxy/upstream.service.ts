import type {} from '@fastify/reply-from';
import { Injectable } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { type Instance, ServiceDiscovery } from '../consul/service-discovery.service';
import { GatewayMetrics } from '../metrics/gateway-metrics';
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

// One attempt; code = the error code of a failed attempt (decides the retry of POST, PUT, PATCH, DELETE).
type AttemptResult = ForwardResult & { code?: string };

// At most 3 attempts per request, each on another instance (Z15): at most 2 retries (D2). Several pods may
// end at once (HPA scale-down, kubectl scale) while the cached list still has them.
const MAX_ATTEMPTS = 3;
// These methods are retried after any lost connection (decision 11), including a reset after sending.
const RETRIED_METHODS = new Set(['GET', 'HEAD']);
// The connection was never established: the request never reached the service (Z11). A reset
// (ECONNRESET) may come after the request was sent, so it is not in this set.
const NOT_CONNECTED_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

@Injectable()
export class UpstreamService {
  constructor(
    private readonly discovery: ServiceDiscovery,
    private readonly metrics: GatewayMetrics,
    @InjectPinoLogger(UpstreamService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Step 10 of guidelines 3.4: the request to the instance chosen in step 9, through reply-from.
   * No connection -> the instance is evicted from the cached list and the request goes at once to the next
   * instance from Consul that was not tried yet, up to MAX_ATTEMPTS attempts (Z15): GET/HEAD after any lost
   * connection, other methods only when the connection was never established (Z11). No more instances to
   * try -> the result of the last attempt. No retry after a timeout or a 5xx response. The caller runs
   * forward() through the circuit, so the request counts there once (the result of the last attempt).
   */
  async forward(
    service: string,
    instance: Instance,
    request: FastifyRequest,
    reply: FastifyReply,
    target: UpstreamRequest,
  ): Promise<ForwardResult> {
    const tried = new Set<string>();
    let current = instance;
    for (;;) {
      tried.add(current.id);
      const result = await this.attempt(service, current, request, reply, target);
      if (result.kind !== 'unreachable') {
        return result;
      }
      this.discovery.evict(service, current);
      if (tried.size >= MAX_ATTEMPTS) {
        return result;
      }
      // Other methods only when the connection was never established: the request never reached the service,
      // so a retry cannot run it twice.
      if (!RETRIED_METHODS.has(request.method) && !NOT_CONNECTED_CODES.has(result.code ?? '')) {
        return result;
      }
      const next = await this.nextUntried(service, tried);
      if (!next) {
        return result;
      }
      current = next;
    }
  }

  /**
   * Next instance of the round robin that was not tried for this request, or null. evict() keeps the tried
   * ones out of the cached list, but a refresh from Consul may bring them back: tried.size + 1 calls reach
   * every other instance of the list.
   */
  private async nextUntried(service: string, tried: ReadonlySet<string>): Promise<Instance | null> {
    for (let i = 0; i <= tried.size; i += 1) {
      const next = await this.discovery.getInstance(service);
      if (!next) {
        return null;
      }
      if (!tried.has(next.id)) {
        return next;
      }
    }
    return null;
  }

  private attempt(
    service: string,
    instance: Instance,
    request: FastifyRequest,
    reply: FastifyReply,
    target: UpstreamRequest,
  ): Promise<AttemptResult> {
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
      // Every attempt is counted, also the retries on other instances (up to MAX_ATTEMPTS per request).
      this.metrics.recordUpstreamAttempt(service, instance.id);
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
          resolve({ kind, upstream, code });
        },
      });
    });
  }
}
