// The access token lives only in this module's memory (decision 14): never in web storage,
// cookies, the address bar or console logs. Claims are read without verification, only for the UI;
// the Gateway enforces permissions.
import type { AccessTokenClaims, UserRole } from '@/api/types';

let accessToken: string | null = null;
let claims: AccessTokenClaims | null = null;
/** Expiry in the clock of this browser: `exp` is in the clock of Auth, which may differ by minutes. */
let expiresAt: number | null = null;
const listeners = new Set<() => void>();

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const ROLES: readonly UserRole[] = ['CUSTOMER', 'ADMIN'];

/** Reads `sub`, `roles` and `exp` from the token payload; null when the token is not a JWT with these claims. */
export function decodeClaims(token: string): AccessTokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload: unknown = JSON.parse(decodeBase64Url(parts[1]));
    if (typeof payload !== 'object' || payload === null) return null;
    const { sub, roles, exp } = payload as Record<string, unknown>;
    if (typeof sub !== 'string' || typeof exp !== 'number' || !Array.isArray(roles)) return null;
    return {
      ...(payload as AccessTokenClaims),
      roles: roles.filter((role): role is UserRole => ROLES.includes(role as UserRole)),
    };
  } catch {
    return null;
  }
}

/** Lifetime of the token (exp − iat) counted from now, so a wrong clock of the browser does not matter; without iat only exp is left. */
function localExpiry({ exp, iat }: AccessTokenClaims): number {
  return typeof iat === 'number' ? Date.now() + (exp - iat) * 1000 : exp * 1000;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getClaims(): AccessTokenClaims | null {
  return claims;
}

/** Stores the token (or clears it with null). A token without readable claims is treated as no token. */
export function setAccessToken(token: string | null): void {
  const nextClaims = token === null ? null : decodeClaims(token);
  accessToken = nextClaims ? token : null;
  claims = nextClaims;
  expiresAt = nextClaims && localExpiry(nextClaims);
  for (const listener of listeners) listener();
}

export function subscribeToken(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True when there is a token and it expires within `ms` milliseconds (or already expired), in the local clock. */
export function tokenExpiresWithin(ms: number, now: number = Date.now()): boolean {
  return expiresAt !== null && expiresAt - now < ms;
}
