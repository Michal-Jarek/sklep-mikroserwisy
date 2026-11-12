import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '@/api/paths';
import { deferred, errorResponse, fakeToken, jsonResponse, requestHeaders, requestPath, tokenResponse } from '@/test/auth';

// Fresh modules in every test: the token and the session are module state.
async function load() {
  vi.resetModules();
  const client = await import('@/api/client');
  const errors = await import('@/api/errors');
  const session = await import('@/auth/session');
  const token = await import('@/auth/token');
  return { ...client, ...errors, ...session, ...token };
}

type FetchArgs = [RequestInfo | URL, RequestInit | undefined];

function stubFetch(handler: (path: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(requestPath(input), init)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function calls(fetchMock: { mock: { calls: unknown[][] } }, path: string) {
  return (fetchMock.mock.calls as FetchArgs[]).filter(([input]) => requestPath(input) === path);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('apiRequest headers', () => {
  it('sends Accept, a UUID X-Request-Id, same-origin credentials and the bearer token outside /auth', async () => {
    const m = await load();
    const token = fakeToken();
    m.setAccessToken(token);
    const fetchMock = stubFetch(() => jsonResponse(200, { items: [] }));

    await m.apiRequest('/cart');

    const [input, init] = fetchMock.mock.calls[0] as FetchArgs;
    const headers = requestHeaders(init);
    expect(requestPath(input)).toBe('/api/v1/cart');
    expect(init?.method).toBe('GET');
    expect(init?.credentials).toBe('same-origin');
    expect(headers.get('Accept')).toBe('application/json');
    expect(headers.get('X-Request-Id')).toMatch(UUID);
    expect(headers.get('Authorization')).toBe(`Bearer ${token}`);
    expect(headers.has('Content-Type')).toBe(false);
  });

  it('never sends the access token to /auth endpoints', async () => {
    const m = await load();
    m.setAccessToken(fakeToken());
    const fetchMock = stubFetch(() => new Response(null, { status: 204 }));

    await m.apiRequest(paths.auth.logout, { method: 'POST' });

    expect(requestHeaders(fetchMock.mock.calls[0][1]).has('Authorization')).toBe(false);
  });

  it('uses a new X-Request-Id for every request', async () => {
    const m = await load();
    const fetchMock = stubFetch(() => jsonResponse(200, []));

    await m.apiRequest('/categories');
    await m.apiRequest('/categories');

    const ids = (fetchMock.mock.calls as FetchArgs[]).map(([, init]) => requestHeaders(init).get('X-Request-Id'));
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('sends the body as JSON with Content-Type and skips empty query values', async () => {
    const m = await load();
    const fetchMock = stubFetch(() => jsonResponse(201, { id: 'a1' }));

    await m.apiRequest('/products', { method: 'POST', body: { name: 'Kubek' }, query: { q: 'a b', page: 2, categoryId: undefined, sort: '' } });

    const [input, init] = fetchMock.mock.calls[0] as FetchArgs;
    expect(requestPath(input)).toBe('/api/v1/products?q=a+b&page=2');
    expect(requestHeaders(init).get('Content-Type')).toBe('application/json');
    expect(init?.body).toBe('{"name":"Kubek"}');
  });

  it('returns undefined for 204 and the parsed JSON otherwise', async () => {
    const m = await load();
    stubFetch((path) => (path.startsWith('/api/v1/cart/items') ? new Response(null, { status: 204 }) : jsonResponse(200, { total: '19.99' })));

    await expect(m.apiRequest('/cart/items/p1', { method: 'DELETE' })).resolves.toBeUndefined();
    await expect(m.apiRequest('/cart')).resolves.toEqual({ total: '19.99' });
  });
});

describe('apiRequest errors', () => {
  it('turns a JSON error body into ApiError with status, code and requestId', async () => {
    const m = await load();
    stubFetch(() => jsonResponse(409, { status: 409, error: 'EMAIL_TAKEN', message: 'Email already registered', requestId: 'rid-1' }));

    const error = await m.apiRequest(paths.auth.register, { method: 'POST', body: {} }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(m.ApiError);
    expect(error).toMatchObject({ status: 409, code: 'EMAIL_TAKEN', requestId: 'rid-1', retryAfter: null });
    expect(m.errorMessage(error)).toBe('Konto z tym adresem e-mail już istnieje.');
  });

  it('turns a non-JSON error response into ApiError by status with the X-Request-Id header', async () => {
    const m = await load();
    stubFetch(() => new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html', 'X-Request-Id': 'nginx-rid' } }));

    const error = await m.apiRequest('/products').catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 502, code: 'HTTP_502', requestId: 'nginx-rid' });
    expect(m.errorMessage(error)).toBe('Usługa jest chwilowo niedostępna. Spróbuj ponownie za chwilę.');
  });

  it('reads Retry-After seconds into retryAfter', async () => {
    const m = await load();
    stubFetch(() => errorResponse(429, 'TOO_MANY_REQUESTS', { 'Retry-After': '42' }));

    const error = await m.apiRequest(paths.auth.login, { method: 'POST', body: {} }).catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 429, code: 'TOO_MANY_REQUESTS', retryAfter: 42 });
    expect(m.errorMessage(error)).toBe('Zbyt wiele prób. Spróbuj ponownie za 42 s.');
  });

  it('turns a network failure into NETWORK_ERROR with its own request id', async () => {
    const m = await load();
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });

    const error = await m.apiRequest('/products').catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 0, code: m.NETWORK_ERROR });
    expect((error as InstanceType<typeof m.ApiError>).requestId).toMatch(UUID);
  });

  it('aborts after 15 s and reports a network error', async () => {
    vi.useFakeTimers();
    const m = await load();
    stubFetch(
      (_path, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );

    const result = m.apiRequest('/products').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(m.REQUEST_TIMEOUT_MS);

    await expect(result).resolves.toMatchObject({ code: m.NETWORK_ERROR });
  });
});

describe('apiRequest with an expired access token', () => {
  it('on 401 refreshes once and repeats the request once with the new token', async () => {
    const m = await load();
    const oldToken = fakeToken();
    const newToken = fakeToken({ sub: 'fresh-user' });
    m.setAccessToken(oldToken);
    const fetchMock = stubFetch((path, init) => {
      if (path === '/api/v1/auth/refresh') return tokenResponse(newToken);
      const auth = requestHeaders(init).get('Authorization');
      return auth === `Bearer ${newToken}` ? jsonResponse(200, { ok: true }) : errorResponse(401, 'UNAUTHORIZED');
    });

    await expect(m.apiRequest('/users/me')).resolves.toEqual({ ok: true });

    expect(calls(fetchMock, '/api/v1/auth/refresh')).toHaveLength(1);
    const repeated = calls(fetchMock, '/api/v1/users/me');
    expect(repeated).toHaveLength(2);
    expect(requestHeaders(repeated[1][1]).get('Authorization')).toBe(`Bearer ${newToken}`);
    expect(m.getAccessToken()).toBe(newToken);
  });

  it('does not refresh again when the repeated request also gets 401', async () => {
    const m = await load();
    m.setAccessToken(fakeToken());
    const fetchMock = stubFetch((path) => (path === '/api/v1/auth/refresh' ? tokenResponse(fakeToken()) : errorResponse(401, 'UNAUTHORIZED')));

    const error = await m.apiRequest('/orders').catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 401 });
    expect(calls(fetchMock, '/api/v1/auth/refresh')).toHaveLength(1);
    expect(calls(fetchMock, '/api/v1/orders')).toHaveLength(2);
  });

  it('three concurrent 401 responses share one refresh', async () => {
    const m = await load();
    const newToken = fakeToken({ sub: 'fresh-user' });
    m.setAccessToken(fakeToken());
    const refresh = deferred<Response>();
    const fetchMock = stubFetch((path, init) => {
      if (path === '/api/v1/auth/refresh') return refresh.promise;
      return requestHeaders(init).get('Authorization') === `Bearer ${newToken}` ? jsonResponse(200, { path }) : errorResponse(401, 'UNAUTHORIZED');
    });

    const results = Promise.all([m.apiRequest('/cart'), m.apiRequest('/users/me'), m.apiRequest('/orders')]);
    await vi.waitFor(() => expect(calls(fetchMock, '/api/v1/auth/refresh')).toHaveLength(1));
    refresh.resolve(tokenResponse(newToken));

    await expect(results).resolves.toHaveLength(3);
    expect(calls(fetchMock, '/api/v1/auth/refresh')).toHaveLength(1);
  });

  it('refresh 401 clears the session and asks for the login page with returnTo', async () => {
    const m = await load();
    window.history.replaceState(null, '', '/orders?page=2');
    m.setAccessToken(fakeToken());
    stubFetch((path) => (path === '/api/v1/auth/refresh' ? errorResponse(401, 'UNAUTHORIZED') : errorResponse(401, 'UNAUTHORIZED')));

    const error = await m.apiRequest('/orders').catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(m.getAccessToken()).toBeNull();
    expect(m.getSession().expiredRedirect).toBe('/login?returnTo=%2Forders%3Fpage%3D2');
  });

  it('refreshes before the request when the token expires within 30 s', async () => {
    const m = await load();
    const newToken = fakeToken();
    m.setAccessToken(fakeToken({ expiresInSeconds: 20 }));
    const fetchMock = stubFetch((path) => (path === '/api/v1/auth/refresh' ? tokenResponse(newToken) : jsonResponse(200, {})));

    await m.apiRequest('/cart');

    const order = (fetchMock.mock.calls as FetchArgs[]).map(([input]) => requestPath(input));
    expect(order).toEqual(['/api/v1/auth/refresh', '/api/v1/cart']);
    expect(requestHeaders(fetchMock.mock.calls[1][1]).get('Authorization')).toBe(`Bearer ${newToken}`);
  });

  it('does not refresh on 401 from /auth endpoints or from requests without a token', async () => {
    const m = await load();
    const fetchMock = stubFetch(() => errorResponse(401, 'INVALID_CREDENTIALS'));

    await expect(m.apiRequest(paths.auth.login, { method: 'POST', body: {} })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await expect(m.apiRequest('/cart')).rejects.toMatchObject({ status: 401 });

    expect(calls(fetchMock, '/api/v1/auth/refresh')).toHaveLength(0);
  });
});

describe('apiRequest when the refresh fails with another error than 401 (C1)', () => {
  const unavailable: [string, () => Response][] = [
    ['503', () => errorResponse(503, 'SERVICE_UNAVAILABLE')],
    ['502 (HTML of nginx)', () => new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } })],
    ['429', () => errorResponse(429, 'TOO_MANY_REQUESTS', { 'Retry-After': '30' })],
    [
      'no connection',
      () => {
        throw new TypeError('Failed to fetch');
      },
    ],
  ];

  it.each(unavailable)('expired token, refresh %s: a public request still goes out with the current token and returns data', async (_name, refresh) => {
    const m = await load();
    const expired = fakeToken({ expiresInSeconds: -60 });
    m.setAccessToken(expired);
    const fetchMock = stubFetch((path) => (path === '/api/v1/auth/refresh' ? refresh() : jsonResponse(200, { items: [] })));

    await expect(m.apiRequest('/products')).resolves.toEqual({ items: [] });

    const order = (fetchMock.mock.calls as FetchArgs[]).map(([input]) => requestPath(input));
    expect(order).toEqual(['/api/v1/auth/refresh', '/api/v1/products']);
    // The Gateway treats an expired token on a public route as anonymous (decision 16 of stage 3).
    expect(requestHeaders(fetchMock.mock.calls[1][1]).get('Authorization')).toBe(`Bearer ${expired}`);
    expect(m.getAccessToken()).toBe(expired);
    expect(m.getSession().expiredRedirect).toBeNull();
  });

  it('expired token, refresh 503: a protected request gets 401, one more refresh and ends with 503 without a loop', async () => {
    const m = await load();
    m.setAccessToken(fakeToken({ expiresInSeconds: -60 }));
    const fetchMock = stubFetch((path) => (path === '/api/v1/auth/refresh' ? errorResponse(503, 'SERVICE_UNAVAILABLE') : errorResponse(401, 'UNAUTHORIZED')));

    const error = await m.apiRequest('/orders').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(m.ApiError);
    expect(error).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    // Proactive refresh, the request, the refresh after its 401 — and nothing more.
    const order = (fetchMock.mock.calls as FetchArgs[]).map(([input]) => requestPath(input));
    expect(order).toEqual(['/api/v1/auth/refresh', '/api/v1/orders', '/api/v1/auth/refresh']);
    // The session stays: Auth did not say the refresh token is invalid.
    expect(m.getAccessToken()).not.toBeNull();
    expect(m.getSession().expiredRedirect).toBeNull();
  });

  it('valid token, 401 and refresh 503: ApiError 503, one refresh, the session stays', async () => {
    const m = await load();
    const token = fakeToken();
    m.setAccessToken(token);
    const fetchMock = stubFetch((path) => (path === '/api/v1/auth/refresh' ? errorResponse(503, 'SERVICE_UNAVAILABLE') : errorResponse(401, 'UNAUTHORIZED')));

    await expect(m.apiRequest('/orders')).rejects.toMatchObject({ status: 503 });

    expect(calls(fetchMock, '/api/v1/auth/refresh')).toHaveLength(1);
    expect(calls(fetchMock, '/api/v1/orders')).toHaveLength(1);
    expect(m.getAccessToken()).toBe(token);
    expect(m.getSession().expiredRedirect).toBeNull();
  });

  it('expired token, refresh 401: the request is not sent and the session expires as before', async () => {
    const m = await load();
    m.setAccessToken(fakeToken({ expiresInSeconds: -60 }));
    const fetchMock = stubFetch((path) => (path === '/api/v1/auth/refresh' ? errorResponse(401, 'UNAUTHORIZED') : jsonResponse(200, { items: [] })));

    await expect(m.apiRequest('/products')).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });

    expect(calls(fetchMock, '/api/v1/products')).toHaveLength(0);
    expect(m.getAccessToken()).toBeNull();
    expect(m.getSession().expiredRedirect).toBe('/login');
  });
});

describe('apiRequest and a refresh finished by another request', () => {
  it('a 401 that arrives after another request already refreshed repeats with the new token without a second refresh', async () => {
    const m = await load();
    const oldToken = fakeToken();
    const newToken = fakeToken({ sub: 'fresh-user' });
    m.setAccessToken(oldToken);
    const late401 = deferred<Response>();
    const fetchMock = stubFetch((path, init) => {
      if (path === '/api/v1/auth/refresh') return tokenResponse(newToken);
      const auth = requestHeaders(init).get('Authorization');
      if (path === '/api/v1/orders' && auth === `Bearer ${oldToken}`) return late401.promise;
      return auth === `Bearer ${newToken}` ? jsonResponse(200, { path }) : errorResponse(401, 'UNAUTHORIZED');
    });

    const slow = m.apiRequest('/orders');
    await vi.waitFor(() => expect(calls(fetchMock, '/api/v1/orders')).toHaveLength(1));
    // Another request gets 401 first and refreshes the session.
    await expect(m.apiRequest('/cart')).resolves.toEqual({ path: '/api/v1/cart' });
    late401.resolve(errorResponse(401, 'UNAUTHORIZED'));

    await expect(slow).resolves.toEqual({ path: '/api/v1/orders' });
    expect(calls(fetchMock, '/api/v1/auth/refresh')).toHaveLength(1);
    expect(requestHeaders(calls(fetchMock, '/api/v1/orders')[1][1]).get('Authorization')).toBe(`Bearer ${newToken}`);
  });
});

describe('apiRequest with a clock of the browser that is wrong (C19)', () => {
  it('a fresh token is sent without a refresh when the clock of the browser is 20 min ahead of Auth', async () => {
    const m = await load();
    // Issued by Auth now; the browser thinks it is 20 minutes later (exp is already "in the past").
    const token = fakeToken();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 20 * 60_000);
    m.setAccessToken(token);
    const fetchMock = stubFetch(() => jsonResponse(200, {}));

    await m.apiRequest('/cart');

    expect((fetchMock.mock.calls as FetchArgs[]).map(([input]) => requestPath(input))).toEqual(['/api/v1/cart']);
  });
});

describe('apiRequest without AbortSignal.any (Safari < 17.4, C17)', () => {
  let any: PropertyDescriptor | undefined;

  beforeEach(() => {
    any = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true, writable: true });
  });

  afterEach(() => {
    if (any) Object.defineProperty(AbortSignal, 'any', any);
    else delete (AbortSignal as { any?: unknown }).any;
  });

  /** fetch that never answers and rejects with the reason of its signal when aborted (like fetch, also at once). */
  function stubHangingFetch() {
    return stubFetch(
      (_path, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    );
  }

  it('a request with the signal of the caller works and removes its abort listener afterwards', async () => {
    const m = await load();
    expect(AbortSignal.any).toBeUndefined();
    stubFetch(() => jsonResponse(200, { items: [] }));
    const caller = new AbortController();
    const add = vi.spyOn(caller.signal, 'addEventListener');
    const remove = vi.spyOn(caller.signal, 'removeEventListener');

    await expect(m.apiRequest('/products', { signal: caller.signal })).resolves.toEqual({ items: [] });

    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1]);
  });

  it('aborting by the caller aborts the request with the reason of the caller, not as a network error', async () => {
    const m = await load();
    stubHangingFetch();
    const caller = new AbortController();

    const result = m.apiRequest('/products', { signal: caller.signal }).catch((e: unknown) => e);
    caller.abort();
    const error = await result;

    expect(error).not.toBeInstanceOf(m.ApiError);
    expect(error).toMatchObject({ name: 'AbortError' });
  });

  it('a signal aborted before the call aborts the request at once', async () => {
    const m = await load();
    const fetchMock = stubHangingFetch();
    const caller = new AbortController();
    caller.abort();

    await expect(m.apiRequest('/products', { signal: caller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
  });

  it('with the signal of the caller the 15 s timeout still ends in a network error', async () => {
    vi.useFakeTimers();
    const m = await load();
    stubHangingFetch();

    const result = m.apiRequest('/products', { signal: new AbortController().signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(m.REQUEST_TIMEOUT_MS);

    await expect(result).resolves.toMatchObject({ code: m.NETWORK_ERROR });
  });
});
