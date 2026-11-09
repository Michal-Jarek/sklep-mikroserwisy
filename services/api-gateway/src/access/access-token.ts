import { decodeJwt, decodeProtectedHeader, errors, jwtVerify, type JWTPayload, type createLocalJWKSet } from 'jose';
import type { GatewayConfig } from '../config/gateway-config';
import type { Identity } from './access-control.service';

export type KeySet = ReturnType<typeof createLocalJWKSet>;

export type TokenCheck = { valid: true; identity: Identity } | { valid: false; reason: string };

// Roles a client token may carry; anything else (SERVICE included) is dropped (decision 13).
export const CLIENT_ROLES: readonly string[] = ['CUSTOMER', 'ADMIN'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// "Bearer <token>", scheme in any case (RFC 6750 b64token).
const BEARER = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i;

export function invalid(reason: string): TokenCheck {
  return { valid: false, reason };
}

/** The token from "Authorization: Bearer <token>", or null for another scheme or a header without a token. */
export function bearerToken(authorization: string): string | null {
  return BEARER.exec(authorization)?.[1] ?? null;
}

/**
 * kid from the header of a compact JWS with a JSON header and a JSON object payload.
 * Returns the rejection reason instead when the token is malformed or has no kid.
 */
export function tokenKid(token: string): { kid: string } | { reason: string } {
  let kid: unknown;
  try {
    decodeJwt(token);
    kid = decodeProtectedHeader(token).kid;
  } catch {
    return { reason: 'malformed token' };
  }
  // Checked here: with a single key in the set jose would pick it for a token without kid.
  return typeof kid === 'string' && kid !== '' ? { kid } : { reason: 'missing kid' };
}

function joseReason(error: unknown): string {
  if (error instanceof errors.JWTClaimValidationFailed) {
    return `${error.code} (${error.claim})`;
  }
  return error instanceof errors.JOSEError ? error.code : 'verification failed';
}

/**
 * Verifies an access token from Auth Service (decision 13): RS256 only, issuer and audience from the
 * configuration, exp, iat and sub required, no clock tolerance; sub must be a UUID and roles a list of
 * strings with at least one of CUSTOMER, ADMIN (other roles are dropped, the order is kept).
 */
export async function verifyAccessToken(token: string, keys: KeySet, jwt: GatewayConfig['jwt']): Promise<TokenCheck> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      algorithms: ['RS256'],
      issuer: jwt.issuer,
      audience: jwt.audience,
      requiredClaims: ['exp', 'iat', 'sub'],
    }));
  } catch (error) {
    return invalid(joseReason(error));
  }
  if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)) {
    return invalid('sub is not a UUID');
  }
  const roles: unknown = payload.roles;
  if (!Array.isArray(roles) || !roles.every((role) => typeof role === 'string')) {
    return invalid('roles is not a list of strings');
  }
  const allowed = roles.filter((role) => CLIENT_ROLES.includes(role));
  if (allowed.length === 0) {
    return invalid('no client role');
  }
  return { valid: true, identity: { userId: payload.sub, roles: allowed } };
}
