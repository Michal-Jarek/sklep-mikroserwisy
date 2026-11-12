// Helpers for tests of the mocks: direct fetch to /api/v1/… (the app itself calls the API only through src/api/client.ts).
import { mockAccessToken } from './handlers/auth';
import { MOCK_ACCOUNTS, SEED_IDS } from './seed';

export interface CallOptions {
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
}

export interface CallResult<T> {
  status: number;
  body: T;
  headers: Headers;
}

export async function call<T = unknown>(method: string, path: string, options: CallOptions = {}): Promise<CallResult<T>> {
  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  const response = await fetch(new URL(`/api/v1${path}`, window.location.origin), {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T, headers: response.headers };
}

/** Logs in with a mock account through POST /auth/login and returns the access token. */
export async function login(account: keyof typeof MOCK_ACCOUNTS): Promise<string> {
  const result = await call<{ accessToken: string }>('POST', '/auth/login', { body: MOCK_ACCOUNTS[account] });
  if (result.status !== 200) {
    throw new Error(`Login of ${account} failed: ${result.status}`);
  }
  return result.body.accessToken;
}

export const customerToken = (): string => mockAccessToken(SEED_IDS.customer, ['CUSTOMER']);
export const adminToken = (): string => mockAccessToken(SEED_IDS.admin, ['ADMIN']);
