import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { StrictMode, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, errorResponse, fakeToken, requestPath, tokenResponse } from '@/test/auth';
import { createTestBroadcastChannel } from '@/test/broadcast-channel';

async function load() {
  vi.resetModules();
  const session = await import('@/auth/session');
  const token = await import('@/auth/token');
  const provider = await import('@/auth/AuthProvider');
  const client = await import('@/api/client');
  const errors = await import('@/api/errors');
  return { ...session, ...token, ...provider, ...client, ...errors };
}

function stubFetch(handler: (path: string) => Response | Promise<Response>) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => Promise.resolve(handler(requestPath(input))));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function callsTo(fetchMock: { mock: { calls: unknown[][] } }, path: string) {
  return fetchMock.mock.calls.filter(([input]) => requestPath(input as string) === path).length;
}

function refreshCalls(fetchMock: { mock: { calls: unknown[][] } }) {
  return callsTo(fetchMock, '/api/v1/auth/refresh');
}

/** Lets pending promises, the test lock manager and the test channel run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const channels: BroadcastChannel[] = [];
/** A channel of "another tab". */
function otherTab(): BroadcastChannel {
  const channel = new BroadcastChannel('sklep-auth');
  channels.push(channel);
  return channel;
}

beforeEach(() => {
  // Channels opened by session modules of earlier tests stay open; a fresh channel class per test isolates them.
  vi.stubGlobal('BroadcastChannel', createTestBroadcastChannel());
});

afterEach(() => {
  for (const channel of channels.splice(0)) channel.close();
});

describe('session start-up', () => {
  it('starts with one refresh and becomes authenticated on 200', async () => {
    const m = await load();
    const fetchMock = stubFetch(() => tokenResponse(fakeToken({ sub: 'user-1', roles: ['ADMIN'] })));

    expect(m.getSession().status).toBe('loading');
    await m.startSession();

    expect(refreshCalls(fetchMock)).toBe(1);
    expect(m.getSession()).toMatchObject({ status: 'authenticated', userId: 'user-1', roles: ['ADMIN'] });
  });

  it('becomes anonymous without a message on 401', async () => {
    const m = await load();
    stubFetch(() => errorResponse(401, 'UNAUTHORIZED'));

    await m.startSession();

    expect(m.getSession()).toMatchObject({ status: 'anonymous', userId: null, expiredRedirect: null });
  });

  it('becomes anonymous without a message on another error', async () => {
    const m = await load();
    stubFetch(() => errorResponse(503, 'SERVICE_UNAVAILABLE'));

    await m.startSession();

    expect(m.getSession()).toMatchObject({ status: 'anonymous', expiredRedirect: null });
  });

  it('double start sends one refresh request', async () => {
    const m = await load();
    const fetchMock = stubFetch(() => tokenResponse(fakeToken()));

    await Promise.all([m.startSession(), m.startSession()]);
    await m.startSession();

    expect(refreshCalls(fetchMock)).toBe(1);
  });

  it('StrictMode (effects run twice) sends one refresh request', async () => {
    const m = await load();
    const fetchMock = stubFetch(() => tokenResponse(fakeToken()));

    // <StrictMode><QueryClientProvider><AuthProvider>app</AuthProvider></QueryClientProvider></StrictMode>
    render(createElement(StrictMode, null, createElement(QueryClientProvider, { client: new QueryClient() }, createElement(m.AuthProvider, null, 'app'))));

    await vi.waitFor(() => expect(m.getSession().status).toBe('authenticated'));
    expect(refreshCalls(fetchMock)).toBe(1);
  });

  it('concurrent refreshes in one tab share one request', async () => {
    const m = await load();
    const fetchMock = stubFetch(() => tokenResponse(fakeToken()));

    const results = await Promise.all([m.refreshSession(), m.refreshSession(), m.refreshSession()]);

    expect(results).toEqual([true, true, true]);
    expect(refreshCalls(fetchMock)).toBe(1);
  });
});

describe('refresh between tabs', () => {
  it('refreshes under navigator.locks with the name sklep-auth-refresh', async () => {
    const m = await load();
    stubFetch(() => tokenResponse(fakeToken()));
    const request = vi.spyOn(navigator.locks, 'request');

    await m.refreshSession();

    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('sklep-auth-refresh');
  });

  it('waits for the lock held by another tab before sending the refresh', async () => {
    const m = await load();
    const fetchMock = stubFetch(() => tokenResponse(fakeToken()));
    const otherTabRefresh = deferred<void>();
    const held = navigator.locks.request('sklep-auth-refresh', () => otherTabRefresh.promise);

    const refreshed = m.refreshSession();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refreshCalls(fetchMock)).toBe(0);

    otherTabRefresh.resolve();
    await held;
    await expect(refreshed).resolves.toBe(true);
    expect(refreshCalls(fetchMock)).toBe(1);
  });

  it('without navigator.locks refreshes only inside the tab', async () => {
    const m = await load();
    const fetchMock = stubFetch(() => tokenResponse(fakeToken()));
    const locks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
    try {
      await expect(Promise.all([m.refreshSession(), m.refreshSession()])).resolves.toEqual([true, true]);
      expect(refreshCalls(fetchMock)).toBe(1);
    } finally {
      if (locks) Object.defineProperty(navigator, 'locks', locks);
    }
  });
});

describe('BroadcastChannel sklep-auth', () => {
  it('login stores the token and tells other tabs "login"', async () => {
    const m = await load();
    const token = fakeToken({ sub: 'user-2' });
    stubFetch((path) => (path === '/api/v1/auth/login' ? tokenResponse(token) : errorResponse(401, 'UNAUTHORIZED')));
    await m.startSession();
    const tab = otherTab();
    const received = new Promise<unknown>((resolve) => {
      tab.onmessage = (event) => resolve(event.data);
    });

    await m.login({ email: 'anna@example.com', password: 'Haslo-1234' });

    expect(m.getAccessToken()).toBe(token);
    expect(m.getSession().status).toBe('authenticated');
    await expect(received).resolves.toBe('login');
  });

  it('a "login" message from another tab makes this tab refresh', async () => {
    const m = await load();
    const fetchMock = stubFetch(() => errorResponse(401, 'UNAUTHORIZED'));
    await m.startSession();
    expect(refreshCalls(fetchMock)).toBe(1);
    fetchMock.mockImplementation(() => Promise.resolve(tokenResponse(fakeToken({ sub: 'user-3' }))));

    otherTab().postMessage('login');

    await vi.waitFor(() => expect(m.getSession()).toMatchObject({ status: 'authenticated', userId: 'user-3' }));
    expect(refreshCalls(fetchMock)).toBe(2);
  });

  it('logout calls Auth, clears the token and tells other tabs "logout"', async () => {
    const m = await load();
    const fetchMock = stubFetch((path) => (path === '/api/v1/auth/logout' ? new Response(null, { status: 204 }) : tokenResponse(fakeToken())));
    await m.startSession();
    const tab = otherTab();
    const received = new Promise<unknown>((resolve) => {
      tab.onmessage = (event) => resolve(event.data);
    });

    await m.logout();

    expect(fetchMock.mock.calls.some(([input]) => requestPath(input as string) === '/api/v1/auth/logout')).toBe(true);
    expect(m.getAccessToken()).toBeNull();
    expect(m.getSession().status).toBe('anonymous');
    await expect(received).resolves.toBe('logout');
  });

  it('a "logout" message from another tab clears the token', async () => {
    const m = await load();
    stubFetch(() => tokenResponse(fakeToken()));
    await m.startSession();
    expect(m.getSession().status).toBe('authenticated');

    otherTab().postMessage('logout');

    await vi.waitFor(() => expect(m.getSession().status).toBe('anonymous'));
    expect(m.getAccessToken()).toBeNull();
  });
});

describe('logout errors (C2, Z19a)', () => {
  const failures: [string, () => Response][] = [
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

  it.each(failures)('logout with %s keeps the token, tells no tab and throws', async (_name, answer) => {
    const m = await load();
    const token = fakeToken();
    stubFetch((path) => (path === '/api/v1/auth/logout' ? answer() : tokenResponse(token)));
    await m.startSession();
    const messages: unknown[] = [];
    otherTab().onmessage = (event) => messages.push(event.data);

    await expect(m.logout()).rejects.toBeInstanceOf(m.ApiError);
    await settle();

    expect(m.getAccessToken()).toBe(token);
    expect(m.getSession().status).toBe('authenticated');
    expect(messages).toEqual([]);
  });

  it('logout with 204 after a failed one clears the token and sends "logout"', async () => {
    const m = await load();
    let logoutStatus = 503;
    stubFetch((path) => (path === '/api/v1/auth/logout' ? (logoutStatus === 204 ? new Response(null, { status: 204 }) : errorResponse(503, 'SERVICE_UNAVAILABLE')) : tokenResponse(fakeToken())));
    await m.startSession();
    const messages: unknown[] = [];
    otherTab().onmessage = (event) => messages.push(event.data);

    await expect(m.logout()).rejects.toMatchObject({ status: 503 });
    logoutStatus = 204;
    await m.logout();
    await settle();

    expect(m.getAccessToken()).toBeNull();
    expect(m.getSession().status).toBe('anonymous');
    expect(messages).toEqual(['logout']);
  });
});

describe('refresh and logout under the lock (C18, C29)', () => {
  it('logout waits for a refresh that holds the lock and calls Auth only after it', async () => {
    const m = await load();
    const refresh = deferred<Response>();
    const order: string[] = [];
    let started = false;
    stubFetch((path) => {
      order.push(path);
      if (path === '/api/v1/auth/logout') return new Response(null, { status: 204 });
      return started ? refresh.promise : tokenResponse(fakeToken());
    });
    await m.startSession();
    started = true;

    const refreshed = m.refreshSession();
    const loggedOut = m.logout();
    await settle();
    expect(order).toEqual(['/api/v1/auth/refresh', '/api/v1/auth/refresh']);

    refresh.resolve(tokenResponse(fakeToken({ sub: 'user-4' })));
    await expect(refreshed).resolves.toBe(true);
    await loggedOut;

    expect(order).toEqual(['/api/v1/auth/refresh', '/api/v1/auth/refresh', '/api/v1/auth/logout']);
    expect(m.getAccessToken()).toBeNull();
  });

  it('a refresh waiting for the lock behind logout gets 401 and ends the session quietly, without "Sesja wygasła"', async () => {
    const m = await load();
    window.history.replaceState(null, '', '/orders');
    const logoutAnswer = deferred<Response>();
    let loggedOut = false;
    const fetchMock = stubFetch((path) => {
      if (path === '/api/v1/auth/logout') return logoutAnswer.promise;
      // After the logout the cookie is gone, so the refresh gets 401.
      if (path === '/api/v1/auth/refresh') return loggedOut ? errorResponse(401, 'UNAUTHORIZED') : tokenResponse(fakeToken());
      return errorResponse(401, 'UNAUTHORIZED');
    });
    await m.startSession();

    const logoutDone = m.logout();
    // A request gets 401 while the logout holds the lock: its refresh waits behind the logout.
    const request = m.apiRequest('/orders').catch((e: unknown) => e);
    await settle();
    expect(callsTo(fetchMock, '/api/v1/orders')).toBe(1);
    expect(refreshCalls(fetchMock)).toBe(1);
    loggedOut = true;
    logoutAnswer.resolve(new Response(null, { status: 204 }));
    await logoutDone;

    await expect(request).resolves.toMatchObject({ status: 401 });
    expect(refreshCalls(fetchMock)).toBe(2);
    expect(m.getSession()).toMatchObject({ status: 'anonymous', expiredRedirect: null });
    window.history.replaceState(null, '', '/');
  });

  it('a "logout" from another tab while this tab waits for the lock to refresh ends the session quietly', async () => {
    const m = await load();
    window.history.replaceState(null, '', '/orders');
    let loggedOut = false;
    const fetchMock = stubFetch((path) => {
      if (path === '/api/v1/auth/refresh') return loggedOut ? errorResponse(401, 'UNAUTHORIZED') : tokenResponse(fakeToken());
      return errorResponse(401, 'UNAUTHORIZED');
    });
    await m.startSession();
    // The other tab logs out under the lock and tells the tabs before it releases the lock.
    const otherTabLogout = deferred<void>();
    const held = navigator.locks.request('sklep-auth-refresh', () => otherTabLogout.promise);

    const request = m.apiRequest('/orders').catch((e: unknown) => e);
    await settle();
    expect(refreshCalls(fetchMock)).toBe(1);
    loggedOut = true;
    otherTab().postMessage('logout');
    otherTabLogout.resolve();
    await held;

    await expect(request).resolves.toMatchObject({ status: 401 });
    expect(refreshCalls(fetchMock)).toBe(2);
    expect(m.getSession()).toMatchObject({ status: 'anonymous', expiredRedirect: null });
    window.history.replaceState(null, '', '/');
  });

  it('a refresh that gets 401 without a logout still ends with "Sesja wygasła" and returnTo', async () => {
    const m = await load();
    window.history.replaceState(null, '', '/orders');
    let expired = false;
    stubFetch((path) => {
      if (path === '/api/v1/auth/refresh') return expired ? errorResponse(401, 'UNAUTHORIZED') : tokenResponse(fakeToken());
      return errorResponse(401, 'UNAUTHORIZED');
    });
    await m.startSession();
    expired = true;

    await expect(m.apiRequest('/orders')).rejects.toMatchObject({ status: 401 });

    expect(m.getSession()).toMatchObject({ status: 'anonymous', expiredRedirect: '/login?returnTo=%2Forders' });
    window.history.replaceState(null, '', '/');
  });
});

describe('returnTo', () => {
  it('accepts local paths with query', async () => {
    const m = await load();
    expect(m.safeReturnTo('/orders?page=2')).toBe('/orders?page=2');
    expect(m.safeReturnTo('/products/123e4567-e89b-42d3-a456-426614174000')).toBe('/products/123e4567-e89b-42d3-a456-426614174000');
  });

  it('rejects //evil.example, /\\evil, https://evil.example and other non-local values', async () => {
    const m = await load();
    for (const value of ['//evil.example', '/\\evil', 'https://evil.example', 'javascript:alert(1)', '/\t/evil.example', 'orders', '', null, undefined]) {
      expect(m.safeReturnTo(value)).toBe('/');
    }
  });

  it('builds the login path with an encoded returnTo', async () => {
    const m = await load();
    expect(m.loginPath('/orders?page=2')).toBe('/login?returnTo=%2Forders%3Fpage%3D2');
    expect(m.loginPath('//evil.example')).toBe('/login');
  });
});
