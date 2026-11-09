import { CORS_ALLOWED_HEADERS, CORS_EXPOSED_HEADERS, CORS_MAX_AGE_SECONDS, corsOptionsFor } from './cors';

const FRONT = 'http://localhost:5173';

describe('corsOptionsFor (decision 21)', () => {
  it('empty list: CORS off for every origin and for preflights', () => {
    expect(corsOptionsFor({ origin: FRONT }, 'GET', [])).toEqual({ origin: false });
    expect(corsOptionsFor({ origin: FRONT, 'access-control-request-method': 'POST' }, 'OPTIONS', [])).toEqual({ origin: false });
  });

  it('an origin from the list gets exactly that origin, credentials, the methods of decision 9 and the headers', () => {
    expect(corsOptionsFor({ origin: FRONT }, 'GET', ['http://other.example', FRONT])).toEqual({
      origin: FRONT,
      credentials: true,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'X-Instance-Id', 'X-Gateway-Instance-Id', 'Retry-After'],
      maxAge: 600,
    });
    expect(CORS_ALLOWED_HEADERS).toHaveLength(3);
    expect(CORS_EXPOSED_HEADERS).toHaveLength(4);
    expect(CORS_MAX_AGE_SECONDS).toBe(600);
  });

  it('a preflight from an origin on the list is handled by CORS', () => {
    expect(corsOptionsFor({ origin: FRONT, 'access-control-request-method': 'POST' }, 'OPTIONS', [FRONT]).origin).toBe(FRONT);
  });

  it.each([
    ['another origin', { origin: 'http://evil.example' }, 'GET'],
    ['an origin differing only in case or port', { origin: 'http://LOCALHOST:5173' }, 'GET'],
    ['no Origin', {}, 'GET'],
    ['OPTIONS without Access-Control-Request-Method (not a preflight)', { origin: FRONT }, 'OPTIONS'],
  ])('%s -> CORS off', (_name, headers, method) => {
    expect(corsOptionsFor(headers, method, [FRONT])).toEqual({ origin: false });
  });
});
