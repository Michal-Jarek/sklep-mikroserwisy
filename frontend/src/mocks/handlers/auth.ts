// Mock Auth (mode `all` only). The refresh "cookie" is the session in the mock state:
// login creates it, refresh rotates it, logout removes it, refresh without it -> 401.
import type { RegisterResponse, TokenResponse, UserRole } from '../../api/types';
import type { MockState } from '../db';
import { encodeBase64Url, errorResponse, json, MockApiError, noContent, route } from '../http';
import { readBody, text } from '../validation';

const TOKEN_TTL_SECONDS = 900;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

/** Three base64url parts like a JWT from Auth; the signature is random bytes (nobody verifies it). */
export function mockAccessToken(userId: string, roles: UserRole[]): string {
  const iat = Math.floor(Date.now() / 1000);
  const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'mock' }));
  const payload = encodeBase64Url(
    JSON.stringify({ sub: userId, roles, iss: 'sklep-auth', aud: 'sklep-api', iat, exp: iat + TOKEN_TTL_SECONDS }),
  );
  const signature = encodeBase64Url(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  return `${header}.${payload}.${signature}`;
}

function tokenResponse(state: MockState, userId: string): TokenResponse {
  const account = state.accounts.find((a) => a.id === userId);
  return {
    accessToken: mockAccessToken(userId, account?.roles ?? ['CUSTOMER']),
    tokenType: 'Bearer',
    expiresIn: TOKEN_TTL_SECONDS,
  };
}

function email(value: unknown): string {
  const normalized = text(value, 'email', 3, 254).toLowerCase();
  if (!EMAIL_PATTERN.test(normalized)) {
    throw new MockApiError(400, 'VALIDATION_ERROR', 'email must be an e-mail address');
  }
  return normalized;
}

function password(value: unknown, minBytes: number): string {
  if (typeof value !== 'string') {
    throw new MockApiError(400, 'VALIDATION_ERROR', 'password must be text');
  }
  const bytes = new TextEncoder().encode(value).length;
  if (bytes < minBytes || bytes > 72) {
    throw new MockApiError(400, 'VALIDATION_ERROR', `password must have ${minBytes}-72 bytes`);
  }
  return value;
}

export const authHandlers = [
  route('POST', '/auth/register', ({ body: raw, state }) => {
    const body = readBody(raw, ['email', 'password', 'firstName', 'lastName']);
    const account = {
      id: crypto.randomUUID(),
      email: email(body.email),
      password: password(body.password, 10),
      firstName: text(body.firstName, 'firstName', 1, 100, true),
      lastName: text(body.lastName, 'lastName', 1, 100, true),
      roles: ['CUSTOMER'] as UserRole[],
    };
    if (state.accounts.some((a) => a.email === account.email)) {
      throw new MockApiError(409, 'EMAIL_TAKEN', 'E-mail is already registered');
    }
    state.accounts.push(account);
    // Auth creates the profile in User (POST /users) during registration.
    state.profiles.push({ id: account.id, firstName: account.firstName, lastName: account.lastName, email: account.email });
    const response: RegisterResponse = {
      id: account.id,
      email: account.email,
      firstName: account.firstName,
      lastName: account.lastName,
      roles: account.roles,
    };
    return json(response, 201);
  }),

  route('POST', '/auth/login', ({ body: raw, state }) => {
    const body = readBody(raw, ['email', 'password']);
    const login = { email: email(body.email), password: password(body.password, 1) };
    const account = state.accounts.find((a) => a.email === login.email && a.password === login.password);
    if (!account) {
      throw new MockApiError(401, 'INVALID_CREDENTIALS', 'Invalid e-mail or password');
    }
    state.session = { userId: account.id, rotation: 0 };
    return json(tokenResponse(state, account.id));
  }),

  route('POST', '/auth/refresh', ({ state, requestId }) => {
    if (state.session === null) {
      return errorResponse(requestId, 401, 'UNAUTHORIZED', 'Missing or invalid refresh token');
    }
    state.session = { userId: state.session.userId, rotation: state.session.rotation + 1 };
    return json(tokenResponse(state, state.session.userId));
  }),

  route('POST', '/auth/logout', ({ state }) => {
    state.session = null;
    return noContent();
  }),
];
