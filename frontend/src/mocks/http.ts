// Shared plumbing of the mock handlers: Gateway access rules, identity from the token,
// planned failures (failNext), D7 error bodies and the response delay.
import { delay, http, HttpResponse, type HttpHandler } from 'msw';
import type { ErrorBody, UserRole } from '../api/types';
import { loadState, mockConfig, saveState, type MockState } from './db';

export const API_PREFIX = '/api/v1';

export interface Identity {
  userId: string;
  roles: UserRole[];
}

export interface RouteContext {
  request: Request;
  params: Record<string, string>;
  url: URL;
  identity: Identity | null;
  state: MockState;
  requestId: string;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type Access = 'public' | 'authenticated' | 'ADMIN' | 'blocked';

// Same rules and order as deploy/consul/config/api-gateway.yaml (first match wins, no match = authenticated).
const ACCESS_RULES: { methods: (Method | 'HEAD' | 'ANY')[]; path: string; access: Access }[] = [
  { methods: ['ANY'], path: '/auth/**', access: 'public' },
  { methods: ['POST'], path: '/users', access: 'blocked' },
  { methods: ['DELETE'], path: '/cart/*', access: 'blocked' },
  { methods: ['ANY'], path: '/inventory/reservations/**', access: 'blocked' },
  { methods: ['ANY'], path: '/orders/purchased/**', access: 'blocked' },
  { methods: ['GET', 'HEAD'], path: '/users/me/**', access: 'authenticated' },
  { methods: ['GET', 'HEAD'], path: '/users/*', access: 'ADMIN' },
  { methods: ['GET', 'HEAD'], path: '/products/**', access: 'public' },
  { methods: ['POST', 'PUT', 'PATCH', 'DELETE'], path: '/products/**', access: 'ADMIN' },
  { methods: ['GET', 'HEAD'], path: '/categories/**', access: 'public' },
  { methods: ['POST', 'PUT', 'PATCH', 'DELETE'], path: '/categories/**', access: 'ADMIN' },
  { methods: ['GET', 'HEAD'], path: '/reviews/**', access: 'public' },
  { methods: ['GET', 'HEAD'], path: '/shipping/methods/**', access: 'public' },
  { methods: ['GET', 'HEAD'], path: '/inventory/*', access: 'public' },
  { methods: ['PUT'], path: '/inventory/*', access: 'ADMIN' },
  { methods: ['PATCH'], path: '/shipments/*/status', access: 'ADMIN' },
];

function patternMatches(pattern: string, path: string): boolean {
  const want = pattern.split('/').filter(Boolean);
  const have = path.split('/').filter(Boolean);
  for (let i = 0; i < want.length; i += 1) {
    if (want[i] === '**') {
      return true;
    }
    if (i >= have.length || (want[i] !== '*' && want[i] !== have[i])) {
      return false;
    }
  }
  return want.length === have.length;
}

export function accessFor(method: string, path: string): Access {
  const rule = ACCESS_RULES.find(
    (r) => (r.methods.includes('ANY') || r.methods.includes(method as Method)) && patternMatches(r.path, path),
  );
  return rule?.access ?? 'authenticated';
}

const DEFAULT_ERRORS: Record<number, string> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  408: 'REQUEST_TIMEOUT',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'TOO_MANY_REQUESTS',
  431: 'REQUEST_HEADER_FIELDS_TOO_LARGE',
  500: 'INTERNAL_ERROR',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
  504: 'GATEWAY_TIMEOUT',
};

export function defaultErrorCode(status: number): string {
  return DEFAULT_ERRORS[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
}

export function errorResponse(
  requestId: string,
  status: number,
  error: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  const body: ErrorBody = { status, error, message, requestId };
  return HttpResponse.json(body, { status, headers: { 'X-Request-Id': requestId, ...headers } });
}

/** Thrown by handlers and validators; turned into a D7 response by the route wrapper. */
export class MockApiError extends Error {
  readonly status: number;
  readonly error: string;

  constructor(status: number, error: string, message: string) {
    super(message);
    this.status = status;
    this.error = error;
  }
}

export const badRequest = (message: string): MockApiError => new MockApiError(400, 'VALIDATION_ERROR', message);
export const notFound = (message = 'Not found'): MockApiError => new MockApiError(404, 'NOT_FOUND', message);

function decodeBase64Url(part: string): string {
  const base64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
  const binary = atob(base64);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

export function encodeBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Identity from the access token payload, like the Gateway (without checking the signature):
 * iss sklep-auth, aud sklep-api, not expired. Works with mock tokens and with real tokens from Auth.
 */
export function identityFrom(request: Request): Identity | null {
  const header = request.headers.get('Authorization');
  const match = header?.match(/^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)$/);
  if (!match) {
    return null;
  }
  try {
    const claims = JSON.parse(decodeBase64Url(match[2])) as Record<string, unknown>;
    const roles = claims.roles;
    const valid =
      isUuid(claims.sub) &&
      claims.iss === 'sklep-auth' &&
      claims.aud === 'sklep-api' &&
      typeof claims.exp === 'number' &&
      claims.exp * 1000 > Date.now() &&
      Array.isArray(roles) &&
      roles.every((r) => r === 'CUSTOMER' || r === 'ADMIN');
    return valid ? { userId: claims.sub as string, roles: roles as UserRole[] } : null;
  } catch {
    return null;
  }
}

function requestIdOf(request: Request): string {
  const supplied = request.headers.get('X-Request-Id') ?? '';
  return /^[A-Za-z0-9._-]{1,64}$/.test(supplied) ? supplied : crypto.randomUUID();
}

function resourceOf(path: string): string {
  return path.split('/').filter(Boolean)[0] ?? '';
}

function plannedFailure(state: MockState, resource: string, requestId: string): Response | null {
  const failure = state.failures[resource];
  if (!failure) {
    return null;
  }
  failure.remaining -= 1;
  if (failure.remaining <= 0) {
    delete state.failures[resource];
  }
  const headers: Record<string, string> = failure.retryAfter !== undefined ? { 'Retry-After': String(failure.retryAfter) } : {};
  return errorResponse(requestId, failure.status, failure.error, 'Planned failure (mocks)', headers);
}

async function respondDelay(): Promise<void> {
  const [min, max] = mockConfig.delayMs;
  if (max > 0) {
    await delay(min + Math.round(Math.random() * (max - min)));
  }
}

export type Resolver = (ctx: RouteContext) => Response | Promise<Response>;

/**
 * One mock endpoint. `path` is the contract path with `:param` (without /api/v1).
 * Order: delay -> planned failure -> Gateway access rule -> handler.
 */
export function route(method: Method, path: string, resolver: Resolver): HttpHandler {
  const factory = { GET: http.get, POST: http.post, PUT: http.put, PATCH: http.patch, DELETE: http.delete }[method];
  return factory(`${API_PREFIX}${path}`, async ({ request, params }) => {
    await respondDelay();
    const url = new URL(request.url);
    const servicePath = url.pathname.slice(API_PREFIX.length);
    const requestId = requestIdOf(request);
    const state = loadState();

    const failure = plannedFailure(state, resourceOf(servicePath), requestId);
    if (failure) {
      saveState(state);
      return failure;
    }

    const identity = identityFrom(request);
    const access = accessFor(method, servicePath);
    if (access === 'blocked') {
      return errorResponse(requestId, 404, 'NOT_FOUND', 'Not found');
    }
    if ((access === 'authenticated' || access === 'ADMIN') && identity === null) {
      return errorResponse(requestId, 401, 'UNAUTHORIZED', 'Missing or invalid access token', {
        'WWW-Authenticate': 'Bearer',
      });
    }
    if (access === 'ADMIN' && !identity?.roles.includes('ADMIN')) {
      return errorResponse(requestId, 403, 'FORBIDDEN', 'Insufficient role');
    }

    try {
      const response = await resolver({
        request,
        params: params as Record<string, string>,
        url,
        identity,
        state,
        requestId,
      });
      saveState(state);
      response.headers.set('X-Request-Id', requestId);
      return response;
    } catch (e) {
      if (e instanceof MockApiError) {
        return errorResponse(requestId, e.status, e.error, e.message);
      }
      throw e;
    }
  });
}

/** Identity of a route that requires login (the wrapper already answered 401 without it). */
export function requireIdentity(ctx: RouteContext): Identity {
  if (ctx.identity === null) {
    throw new MockApiError(401, 'UNAUTHORIZED', 'Missing or invalid access token');
  }
  return ctx.identity;
}

export const isAdmin = (identity: Identity | null): boolean => identity?.roles.includes('ADMIN') ?? false;

export function json(body: unknown, status = 200): Response {
  return HttpResponse.json(body as Parameters<typeof HttpResponse.json>[0], { status });
}

export function noContent(): Response {
  return new HttpResponse(null, { status: 204 });
}

export const now = (): string => new Date().toISOString();
