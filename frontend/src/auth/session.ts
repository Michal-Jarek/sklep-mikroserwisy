// Session of the browser tab (wytyczne 3.5, decision 14). The refresh token is an httpOnly cookie
// set by Auth; Auth revokes the whole token family when a rotated token is used again, so there is
// at most one refresh at a time: one shared promise in the tab and a Web Lock across tabs.
import { useSyncExternalStore } from 'react';
import { apiRequest } from '@/api/client';
import { ApiError } from '@/api/errors';
import { paths } from '@/api/paths';
import type { LoginRequest, RegisterRequest, RegisterResponse, TokenResponse, UserRole } from '@/api/types';
import { getAccessToken, getClaims, setAccessToken, subscribeToken } from '@/auth/token';

export const REFRESH_LOCK_NAME = 'sklep-auth-refresh';
export const AUTH_CHANNEL_NAME = 'sklep-auth';
export const SESSION_EXPIRED_MESSAGE = 'Sesja wygasła. Zaloguj się ponownie.';

export type SessionStatus = 'loading' | 'authenticated' | 'anonymous';

export interface Session {
  /** `loading` until the first refresh at start-up has finished. */
  status: SessionStatus;
  /** `sub` of the access token (only for the UI). */
  userId: string | null;
  roles: readonly UserRole[];
  /** Set when the session ended during a request (refresh got 401): the login page with `returnTo`. */
  expiredRedirect: string | null;
}

type TabMessage = 'login' | 'logout';

let started = false;
let expiredRedirect: string | null = null;
let starting: Promise<void> | null = null;
let refreshing: Promise<boolean> | null = null;
let channel: BroadcastChannel | null = null;
/** Number of logouts (this tab or another) since the module loaded; see sessionGeneration. */
let logouts = 0;
const listeners = new Set<() => void>();

function buildSnapshot(): Session {
  const claims = getClaims();
  return {
    status: claims ? 'authenticated' : started ? 'anonymous' : 'loading',
    userId: claims?.sub ?? null,
    roles: claims?.roles ?? [],
    expiredRedirect,
  };
}

let snapshot = buildSnapshot();

function emit(): void {
  snapshot = buildSnapshot();
  for (const listener of listeners) listener();
}

subscribeToken(emit);

export function getSession(): Session {
  return snapshot;
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSession(): Session {
  return useSyncExternalStore(subscribeSession, getSession);
}

/** Runs `task` under the cross-tab lock; without Web Locks (insecure context) only inside the tab. */
function withRefreshLock<T>(task: () => Promise<T>): Promise<T> {
  const locks = (navigator as Partial<Navigator>).locks;
  return locks ? locks.request(REFRESH_LOCK_NAME, task) : task();
}

function storeToken(response: TokenResponse | undefined): boolean {
  setAccessToken(typeof response?.accessToken === 'string' ? response.accessToken : null);
  return getAccessToken() !== null;
}

async function refreshNow(): Promise<boolean> {
  try {
    return storeToken(await apiRequest<TokenResponse>(paths.auth.refresh, { method: 'POST' }));
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      setAccessToken(null);
      return false;
    }
    throw error;
  }
}

/**
 * Gets a new access token with the refresh cookie. Concurrent calls share one request.
 * Resolves true with a new token, false when the refresh token is not valid (401, token cleared);
 * other errors (e.g. 503) are thrown and leave the session as it was.
 */
export function refreshSession(): Promise<boolean> {
  refreshing ??= withRefreshLock(refreshNow).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/**
 * Changes on every logout (this tab or another). The client compares it before and after a refresh: a refresh
 * that got 401 because a logout ran in between ends the session quietly, without "Sesja wygasła".
 */
export function sessionGeneration(): number {
  return logouts;
}

function endSession(): void {
  logouts += 1;
  setAccessToken(null);
}

function broadcast(message: TabMessage): void {
  channel?.postMessage(message);
}

function listenToOtherTabs(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  channel = new BroadcastChannel(AUTH_CHANNEL_NAME);
  channel.onmessage = (event: MessageEvent) => {
    // Another tab logged in: this tab gets its own access token (under the same lock).
    if (event.data === 'login') refreshSession().catch(() => undefined);
    // Another tab logged out: forget the token; route guards leave protected pages.
    if (event.data === 'logout') endSession();
  };
}

/**
 * Start-up: one refresh (also when called twice, e.g. by StrictMode effects). 200 → logged in;
 * 401 or any other error → anonymous without a message.
 */
export function startSession(): Promise<void> {
  starting ??= (async () => {
    listenToOtherTabs();
    try {
      await refreshSession();
    } catch {
      setAccessToken(null);
    }
    started = true;
    emit();
  })();
  return starting;
}

export async function login(credentials: LoginRequest): Promise<void> {
  const response = await apiRequest<TokenResponse>(paths.auth.login, { method: 'POST', body: credentials });
  if (!storeToken(response)) {
    throw new ApiError({ status: 200, code: 'INVALID_RESPONSE', message: 'Login response has no valid access token', requestId: null, retryAfter: null });
  }
  expiredRedirect = null;
  emit();
  broadcast('login');
}

/** Creates the account (201, no tokens: registration does not log in). */
export function registerAccount(body: RegisterRequest): Promise<RegisterResponse> {
  return apiRequest<RegisterResponse>(paths.auth.register, { method: 'POST', body });
}

/**
 * Logs out under the lock, so it never races with a refresh of another tab using the same cookie.
 * Auth always answers 204; an error (429, 502, 503, no connection) comes from the Gateway, nginx or the
 * network, so the refresh cookie is still valid: the session stays and the error is thrown for the caller
 * to show (Z19a). The token is cleared and the other tabs are told before the lock is released, so a
 * refresh waiting for the lock already sees the logout.
 */
export async function logout(): Promise<void> {
  await withRefreshLock(async () => {
    await apiRequest<void>(paths.auth.logout, { method: 'POST' });
    endSession();
    broadcast('logout');
  });
}

/** Only a local path: starts with `/`, not `//` or `/\`, no control characters or spaces; otherwise `/`. */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !/^\/(?![/\\])/.test(value) || /[\s\p{Cc}]/u.test(value)) return '/';
  return value;
}

export function loginPath(returnTo: string): string {
  const target = safeReturnTo(returnTo);
  return target === '/' ? '/login' : `/login?returnTo=${encodeURIComponent(target)}`;
}

/** Called by the client when the refresh got 401 during a request: clears the token and asks for the login page. */
export function expireSession(): void {
  expiredRedirect = loginPath(window.location.pathname + window.location.search);
  setAccessToken(null);
}

/** The login page has shown "Sesja wygasła…". */
export function acknowledgeSessionExpiry(): void {
  if (expiredRedirect === null) return;
  expiredRedirect = null;
  emit();
}
