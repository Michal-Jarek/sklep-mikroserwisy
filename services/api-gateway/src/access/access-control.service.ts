import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AppException, ERROR_MESSAGES } from '../common/app-exception';
import type { GatewayConfig } from '../config/gateway-config';
import { GatewayConfigState } from '../config/gateway-config-state.service';
import { accessLevel } from './access-rules';
import { bearerToken, invalid, type TokenCheck, tokenKid, verifyAccessToken } from './access-token';
import { JwksProvider } from './jwks-provider.service';

/** Identity passed to the services as X-User-Id and X-User-Roles. roles: only CUSTOMER and/or ADMIN. */
export interface Identity {
  userId: string;
  roles: string[];
}

// The token could not be checked: there are no keys from Auth Service yet.
type Check = TokenCheck | { valid: false; noKeys: true };

@Injectable()
export class AccessControl {
  constructor(
    private readonly configState: GatewayConfigState,
    private readonly jwks: JwksProvider,
    @InjectPinoLogger(AccessControl.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * method: HTTP method; segments: decoded segments of the canonical path without the public prefix
   * (e.g. ['users', 'me']); authorization: raw Authorization header or undefined.
   * Returns the identity to pass on, or null (anonymous). Throws AppException 404 (blocked),
   * 401, 403, 503 (no keys).
   */
  async authorize(method: string, segments: readonly string[], authorization: string | undefined): Promise<Identity | null> {
    const config = this.configState.current();
    if (!config) {
      throw new AppException(503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.serviceUnavailable);
    }
    // Decision 15: blocked -> 404 (same as an unknown route, also for ADMIN), then token, then role.
    const level = accessLevel(config.access, method, segments);
    if (level === 'blocked') {
      throw new AppException(404, 'NOT_FOUND', ERROR_MESSAGES.notFound);
    }
    // userId is added to the request log by the caller (proxy), not here.
    const check = await this.checkToken(authorization, config.jwt);
    if (level === 'public') {
      // Decision 16: an invalid or expired token on a public route makes the request anonymous.
      return check.valid ? check.identity : null;
    }
    if (!check.valid) {
      if ('noKeys' in check) {
        throw new AppException(503, 'SERVICE_UNAVAILABLE', ERROR_MESSAGES.serviceUnavailable);
      }
      throw new AppException(401, 'UNAUTHORIZED', ERROR_MESSAGES.unauthorized);
    }
    if (level === 'ADMIN' && !check.identity.roles.includes('ADMIN')) {
      throw new AppException(403, 'FORBIDDEN', ERROR_MESSAGES.forbidden);
    }
    return check.identity;
  }

  /** A missing header or a malformed token is invalid even without keys; noKeys only for a well-formed token. */
  private async checkToken(authorization: string | undefined, jwt: GatewayConfig['jwt']): Promise<Check> {
    if (authorization === undefined) {
      return invalid('no token');
    }
    const check = await this.verify(authorization, jwt);
    if (!check.valid) {
      // Never the token or its claims, only the reason.
      this.logger.debug({ reason: 'noKeys' in check ? 'no keys' : check.reason }, 'Access token not accepted');
    }
    return check;
  }

  private async verify(authorization: string, jwt: GatewayConfig['jwt']): Promise<Check> {
    const token = bearerToken(authorization);
    if (token === null) {
      return invalid('not a bearer token');
    }
    const header = tokenKid(token);
    if ('reason' in header) {
      return invalid(header.reason);
    }
    const keys = await this.jwks.keysFor(header.kid);
    if (!keys) {
      return { valid: false, noKeys: true };
    }
    // jose rejects a kid that is still unknown after the refresh (ERR_JWKS_NO_MATCHING_KEY).
    return verifyAccessToken(token, keys.keySet, jwt);
  }
}
