import type { AppConfig } from '../config/app-config';

// Every call to Consul has a 2 s timeout (architecture rule).
export const CONSUL_TIMEOUT_MS = 2000;

export function consulFetch(consul: AppConfig['consul'], path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://${consul.host}:${consul.port}${path}`, {
    ...init,
    signal: AbortSignal.timeout(CONSUL_TIMEOUT_MS),
  });
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
