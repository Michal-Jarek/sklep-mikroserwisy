import { HttpException, Injectable } from '@nestjs/common';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AccessControl } from '../access/access-control.service';
import { AppException, ERROR_MESSAGES } from '../common/app-exception';
import { sendError } from '../common/send-error';
import { HTTP_METHODS } from '../config/gateway-config';
import { GatewayConfigState } from '../config/gateway-config-state.service';
import { ServiceDiscovery } from '../consul/service-discovery.service';
import { RateLimiter } from '../limits/rate-limiter.service';
import { canonicalPath, findService } from './canonical-path';
import { CircuitBreakers } from './circuit-breakers.service';
import { UpstreamService } from './upstream.service';

function serviceUnavailable(): AppException {
  return new AppException(503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.serviceUnavailable);
}

/**
 * Handles every request under the public prefix, in the order of guidelines 3.4 (the order is part of
 * the contract). Step 1 (X-Request-Id, X-Gateway-Instance-Id, helmet) runs earlier in onRequest hooks.
 */
@Injectable()
export class ProxyService {
  constructor(
    private readonly configState: GatewayConfigState,
    private readonly access: AccessControl,
    private readonly limits: RateLimiter,
    private readonly breakers: CircuitBreakers,
    private readonly discovery: ServiceDiscovery,
    private readonly upstream: UpstreamService,
    @InjectPinoLogger(ProxyService.name) private readonly logger: PinoLogger,
  ) {}

  /** Fastify route handler: errors are sent in the team format here, outside Nest. */
  handle(request: FastifyRequest, reply: FastifyReply): void {
    this.proxy(request, reply).catch((error: unknown) => sendError(reply, error, request.id, this.logger));
  }

  /**
   * Error handler of the proxy routes: errors Fastify raises before the handler runs (body over 1 MiB,
   * broken body framing, QUERY without Content-Type) get the code and message of their status (3.5).
   */
  handleError(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
    const status = error.statusCode;
    const mapped = status !== undefined && status >= 400 && status < 500 ? new HttpException(error.message, status) : error;
    sendError(reply, mapped, request.id, this.logger);
  }

  private async proxy(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // 2. Configuration from KV not loaded yet.
    const config = this.configState.current();
    if (config === null) {
      throw serviceUnavailable();
    }

    // Canonical path from the raw URL (decision 8): used by the route limit (3) and checked in step 5.
    const target = canonicalPath(request.raw.url ?? '');

    // 3. Rate limits per client IP: global, then the route limit (exact method and canonical path) -> 429.
    await this.limits.check(request, target?.path ?? null, config.rateLimit);

    // 4. Methods passed through the proxy (decision 9); a valid CORS preflight never gets here (decision 21).
    if (!(HTTP_METHODS as readonly string[]).includes(request.method)) {
      throw new AppException(405, 'METHOD_NOT_ALLOWED', ERROR_MESSAGES.methodNotAllowed);
    }

    // 5. Non-canonical path -> 400.
    if (target === null) {
      throw new AppException(400, 'VALIDATION_ERROR', ERROR_MESSAGES.invalidPath);
    }

    // 6. Route by the first segment (decision 7).
    const service = findService(config.routes, target.segments);
    if (service === undefined) {
      throw new AppException(404, 'NOT_FOUND', ERROR_MESSAGES.notFound);
    }
    this.logger.assign({ targetService: service });

    // 7. Access rule and token: throws 404 (blocked), 401, 403 or 503 (no keys).
    const identity = await this.access.authorize(request.method, target.segments, request.headers.authorization);
    if (identity) {
      this.logger.assign({ userId: identity.userId });
    }

    // 8. Circuit of the service open -> 503 without asking Consul or the service (decision 12).
    if (this.breakers.rejects(service)) {
      throw serviceUnavailable();
    }

    // 9. Healthy instance from Consul; none -> 503, not counted by the circuit.
    const instance = await this.discovery.getInstance(service);
    if (!instance) {
      throw serviceUnavailable();
    }

    // 10. The request through the circuit (failures counted), with the retry of GET/HEAD (decision 11).
    const result = await this.breakers.run(service, () =>
      this.upstream.forward(service, instance, request, reply, {
        path: target.path,
        query: target.query,
        forwarded: { requestId: request.id, clientIp: request.ip, identity },
        timeoutMs: config.proxy.timeoutSeconds * 1000,
      }),
    );
    if (result === null) {
      // The circuit opened (or its trial started) while the instance was looked up.
      throw serviceUnavailable();
    }
    if (result.kind === 'response' || result.kind === 'aborted') {
      return;
    }
    this.logger.assign({ upstream: result.upstream });
    if (result.kind === 'timeout') {
      throw new AppException(504, 'GATEWAY_TIMEOUT', ERROR_MESSAGES.gatewayTimeout);
    }
    if (result.kind === 'rejected') {
      throw new AppException(400, 'VALIDATION_ERROR', ERROR_MESSAGES.badRequest);
    }
    throw new AppException(502, 'BAD_GATEWAY', ERROR_MESSAGES.badGateway);
  }
}
