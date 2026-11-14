import type { AppConfig } from '../config/app-config';

// Every call to Consul has a 2 s timeout (architecture rule).
export const CONSUL_TIMEOUT_MS = 2000;

/**
 * Every call to the Consul HTTP API goes through here: with an ACL token (CONSUL_HTTP_TOKEN, Kubernetes) it is sent
 * in X-Consul-Token, without one no header is added (Docker Compose, Consul without ACL).
 */
export function consulFetch(
  consul: AppConfig['consul'],
  path: string,
  init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> } = {},
): Promise<Response> {
  return fetch(`http://${consul.host}:${consul.port}${path}`, {
    ...init,
    headers: consul.token ? { ...init.headers, 'X-Consul-Token': consul.token } : init.headers,
    signal: AbortSignal.timeout(CONSUL_TIMEOUT_MS),
  });
}

/** Error for a Consul answer that is not 2xx; 403 (ACL) names the token variable, never its value. */
export function consulStatusError(what: string, status: number): Error {
  const hint = status === 403 ? ' (ACL: CONSUL_HTTP_TOKEN missing or without permission)' : '';
  return new Error(`${what} responded with ${status}${hint}`);
}

/** Short reason for logs, without a stack trace (e.g. "fetch failed (ECONNREFUSED)"). */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause: unknown = error.cause;
  const code =
    cause !== null && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
      ? cause.code
      : undefined;
  return code ? `${error.message} (${code})` : error.message;
}
