// The only place that calls fetch (decision 11). Adds the access token, the request id and
// the timeout, refreshes the session once on 401 and turns every failure into an ApiError.
import { ApiError, NETWORK_ERROR } from '@/api/errors';
import { API_PREFIX, AUTH_PATH_PREFIX, type HttpMethod } from '@/api/paths';
import type { ErrorBody } from '@/api/types';
// session.ts imports this module too (to call /auth/*); both only use each other inside functions.
import { expireSession, refreshSession, sessionGeneration } from '@/auth/session';
import { getAccessToken, tokenExpiresWithin } from '@/auth/token';

export const REQUEST_TIMEOUT_MS = 15_000;
/** A token that expires sooner than this is refreshed before the request. */
export const TOKEN_REFRESH_MARGIN_MS = 30_000;

export interface RequestOptions {
  method?: HttpMethod;
  /** Query parameters; undefined, null and empty values are left out. */
  query?: object;
  /** Sent as JSON. */
  body?: unknown;
  /** Cancellation by the caller (TanStack Query passes its signal). */
  signal?: AbortSignal;
}

interface RawResponse {
  status: number;
  headers: Headers;
  text: string;
  requestId: string;
}

function buildUrl(path: string, query: object | undefined): string {
  const url = new URL(API_PREFIX + path, window.location.href);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function send(path: string, options: RequestOptions, token: string | null): Promise<RawResponse> {
  const requestId = crypto.randomUUID();
  const headers = new Headers({ Accept: 'application/json', 'X-Request-Id': requestId });
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (token !== null) headers.set('Authorization', `Bearer ${token}`);

  // One controller aborted by the timeout or by the caller's signal (AbortSignal.any is missing in Safari < 17.4).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const callerSignal = options.signal;
  const abortByCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortByCaller();
  else callerSignal?.addEventListener('abort', abortByCaller);
  try {
    const response = await fetch(buildUrl(path, options.query), {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'same-origin',
      signal: controller.signal,
    });
    // The timeout covers the body too.
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, requestId };
  } catch (error) {
    if (callerSignal?.aborted) throw error;
    throw new ApiError({ status: 0, code: NETWORK_ERROR, message: 'No response (network error or timeout)', requestId, retryAfter: null });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', abortByCaller);
  }
}

function parseErrorBody(text: string): Partial<ErrorBody> | null {
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body !== 'object' || body === null || typeof (body as ErrorBody).error !== 'string') return null;
    const { error, message, requestId } = body as Record<string, unknown>;
    return {
      error: error as string,
      message: typeof message === 'string' ? message : undefined,
      requestId: typeof requestId === 'string' ? requestId : undefined,
    };
  } catch {
    return null;
  }
}

function parseRetryAfter(value: string | null): number | null {
  return value !== null && /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
}

function toApiError(raw: RawResponse): ApiError {
  // A non-JSON body (e.g. an HTML error page of a proxy) gets a message by status (decision 13).
  const body = parseErrorBody(raw.text);
  return new ApiError({
    status: raw.status,
    code: body?.error ?? `HTTP_${raw.status}`,
    message: body?.message ?? '',
    requestId: body?.requestId ?? raw.headers.get('X-Request-Id') ?? raw.requestId,
    retryAfter: parseRetryAfter(raw.headers.get('Retry-After')),
  });
}

function parseResponse<T>(raw: RawResponse): T {
  if (raw.status < 200 || raw.status > 299) throw toApiError(raw);
  if (raw.text === '') return undefined as T;
  try {
    return JSON.parse(raw.text) as T;
  } catch {
    throw new ApiError({ status: raw.status, code: 'INVALID_RESPONSE', message: 'Response is not JSON', requestId: raw.headers.get('X-Request-Id') ?? raw.requestId, retryAfter: null });
  }
}

function sessionExpiredError(): ApiError {
  return new ApiError({ status: 401, code: 'UNAUTHORIZED', message: 'Session expired', requestId: null, retryAfter: null });
}

/** Refreshes the session; when the refresh token is no longer valid, ends the session and throws 401. */
async function refreshOrExpire(): Promise<void> {
  const generation = sessionGeneration();
  if (await refreshSession()) return;
  // A refresh that waited for the lock behind a logout (this tab or another) gets 401 too: that is the
  // logout, not an expired session, so no "Sesja wygasła" and no login page.
  if (sessionGeneration() === generation) expireSession();
  throw sessionExpiredError();
}

/**
 * Sends a request to API_PREFIX + `path` (a path from paths.ts) and returns the parsed JSON body
 * (undefined for an empty body, e.g. 204). Throws ApiError for every error response and network error.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (path.startsWith(AUTH_PATH_PREFIX)) return parseResponse<T>(await send(path, options, null));

  if (getAccessToken() !== null && tokenExpiresWithin(TOKEN_REFRESH_MARGIN_MS)) {
    try {
      await refreshOrExpire();
    } catch (error) {
      // Auth unavailable (5xx, 429, no connection): send the request with the current token anyway. The Gateway
      // serves a public route anonymously when the token has expired; a protected one answers 401 and gets
      // one more refresh below (C1).
      if (!(error instanceof ApiError) || error.status === 401) throw error;
    }
  }

  const token = getAccessToken();
  const first = await send(path, options, token);
  if (first.status !== 401 || token === null) return parseResponse<T>(first);

  // One refresh shared by all requests that got 401 with this token, then exactly one repeat.
  if (getAccessToken() === token) await refreshOrExpire();
  const fresh = getAccessToken();
  if (fresh === null) throw sessionExpiredError();
  return parseResponse<T>(await send(path, options, fresh));
}
