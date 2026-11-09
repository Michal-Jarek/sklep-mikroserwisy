import type { IncomingHttpHeaders } from 'node:http';
import type { Identity } from '../access/access-control.service';

/** What the Gateway adds to a request for a service (guidelines 3.2). */
export interface ForwardedFor {
  requestId: string;
  // Address of the client connection (request.ip; no trustProxy, decision 18).
  clientIp: string;
  // null = anonymous: no X-User-* headers.
  identity: Identity | null;
}

// Hop-by-hop headers (RFC 9110 7.6.1) plus the names listed in Connection: they concern one connection only.
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

// Never passed on from the client: credentials (the Gateway checks the token itself), addresses it could fake,
// Expect (Node has already answered 100 Continue and the body is read; undici refuses to send the header)
// and method overrides (a service filter would turn POST into DELETE behind the access rules, Z25).
const REQUEST_REMOVED = [
  'authorization',
  'proxy-authorization',
  'forwarded',
  'x-real-ip',
  'expect',
  'x-http-method-override',
  'x-http-method',
  'x-method-override',
];
const REQUEST_REMOVED_PREFIXES = ['x-user-', 'x-forwarded-'];

const RESPONSE_REMOVED = ['server', 'x-powered-by'];
// CORS belongs to the Gateway (decision 21): a service cannot open cross-origin access on its own.
const RESPONSE_REMOVED_PREFIX = 'access-control-';

function connectionTokens(value: string | string[] | undefined): string[] {
  const joined = Array.isArray(value) ? value.join(',') : (value ?? '');
  return joined
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
}

function withoutHopByHop<T extends Record<string, unknown>>(headers: T): Record<string, unknown> {
  const removed = new Set([...HOP_BY_HOP, ...connectionTokens(headers.connection as string | string[] | undefined)]);
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!removed.has(name.toLowerCase())) {
      result[name] = value;
    }
  }
  return result;
}

/**
 * Headers of a request for a service (decision 17, guidelines 3.2, Z25). Removes Authorization, every
 * X-User-* and X-Forwarded-* header of the client (any case, any number of times), Forwarded,
 * X-Real-IP, Expect, the method overrides X-HTTP-Method-Override, X-HTTP-Method and X-Method-Override,
 * every header with "_" in its name (like nginx with underscores_in_headers off: WSGI servers read
 * X_User_Roles as X-User-Roles) and hop-by-hop headers; Content-Length too, because the HTTP client
 * computes it from the body it actually sends. Sets X-Request-Id, X-Forwarded-For (one address, replaced)
 * and, for a known user, X-User-Id and X-User-Roles. Everything else (Cookie, Content-Type, Accept, ...) stays.
 */
export function buildUpstreamHeaders(clientHeaders: IncomingHttpHeaders, forwarded: ForwardedFor): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(withoutHopByHop(clientHeaders))) {
    const lower = name.toLowerCase();
    if (
      lower === 'content-length' ||
      lower.includes('_') ||
      REQUEST_REMOVED.includes(lower) ||
      REQUEST_REMOVED_PREFIXES.some((prefix) => lower.startsWith(prefix))
    ) {
      continue;
    }
    headers[lower] = value as string | string[] | undefined;
  }
  headers['x-request-id'] = forwarded.requestId;
  headers['x-forwarded-for'] = forwarded.clientIp;
  if (forwarded.identity) {
    headers['x-user-id'] = forwarded.identity.userId;
    headers['x-user-roles'] = forwarded.identity.roles.join(',');
  }
  return headers;
}

/**
 * Headers of a service response passed to the client (decision 19, Z11). Removes Server, X-Powered-By,
 * every Access-Control-* (CORS headers come only from the Gateway) and hop-by-hop headers, and every header
 * the Gateway has already set on the reply (X-Request-Id, X-Gateway-Instance-Id, helmet): on a name conflict
 * the Gateway value wins. The rest (X-Instance-Id, Set-Cookie, Retry-After, Content-Type, ...) is passed on unchanged.
 */
export function filterResponseHeaders<T extends Record<string, unknown>>(
  serviceHeaders: T,
  gatewayHeaderNames: ReadonlySet<string>,
): Record<string, unknown> {
  const headers: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(withoutHopByHop(serviceHeaders))) {
    const lower = name.toLowerCase();
    if (!RESPONSE_REMOVED.includes(lower) && !lower.startsWith(RESPONSE_REMOVED_PREFIX) && !gatewayHeaderNames.has(lower)) {
      headers[name] = value;
    }
  }
  return headers;
}

function varyTokens(value: number | string | string[] | undefined): string[] {
  const joined = Array.isArray(value) ? value.join(',') : String(value ?? '');
  return joined
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/**
 * Vary of a proxied response (pitfall 5b): the value already set by the Gateway (Vary: Origin of CORS)
 * and the one of the service, without duplicates (case-insensitive), "*" when either has it.
 * undefined when the Gateway set no Vary: the service value then passes unchanged.
 */
export function mergeVary(
  gatewayValue: number | string | string[] | undefined,
  serviceValue: string | string[] | undefined,
): string | undefined {
  const gateway = varyTokens(gatewayValue);
  if (gateway.length === 0) {
    return undefined;
  }
  const merged = [...gateway];
  for (const token of varyTokens(serviceValue)) {
    if (!merged.some((existing) => existing.toLowerCase() === token.toLowerCase())) {
      merged.push(token);
    }
  }
  return merged.includes('*') ? '*' : merged.join(', ');
}
