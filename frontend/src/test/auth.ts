// Helpers for unit tests of the client and the session (no MSW: fetch is stubbed).
import type { UserRole } from '@/api/types';

function base64Url(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Unsigned token with a JWT layout and the claims of Auth (the frontend never verifies it). */
export function fakeToken(options: { sub?: string; roles?: UserRole[]; expiresInSeconds?: number } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: options.sub ?? '0b6c1b7e-5d1f-4a43-9a51-2f0d7c3e9a10',
    roles: options.roles ?? ['CUSTOMER'],
    iss: 'sklep-auth',
    aud: 'sklep-api',
    iat: now,
    exp: now + (options.expiresInSeconds ?? 900),
  };
  return `${base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64Url(JSON.stringify(payload))}.signature`;
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

export function tokenResponse(token: string): Response {
  return jsonResponse(200, { accessToken: token, tokenType: 'Bearer', expiresIn: 900 });
}

export function errorResponse(status: number, error: string, headers: Record<string, string> = {}): Response {
  return jsonResponse(status, { status, error, message: 'test', requestId: `rid-${status}` }, headers);
}

/** Path and query of the request URL (without the origin). */
export function requestPath(input: RequestInfo | URL): string {
  const url = new URL(input instanceof Request ? input.url : String(input));
  return url.pathname + url.search;
}

export function requestHeaders(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers);
}

/** Promise that the test resolves by hand. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
