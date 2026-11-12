import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { UserRole } from '@/api/types';
import { errorResponse, fakeToken, requestPath, tokenResponse } from '@/test/auth';
import { renderApp } from '@/test/render-app';

/** The start-up refresh logs in with `roles` (or fails for an anonymous visitor); other services are down. */
function stubSession(roles: UserRole[] | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        requestPath(input) === '/api/v1/auth/refresh' && roles
          ? tokenResponse(fakeToken({ roles }))
          : errorResponse(requestPath(input) === '/api/v1/auth/refresh' ? 401 : 503, requestPath(input) === '/api/v1/auth/refresh' ? 'UNAUTHORIZED' : 'SERVICE_UNAVAILABLE'),
      ),
    ),
  );
}

describe('route guards', () => {
  it('anonymous visitor on a protected page goes to /login?returnTo=…', async () => {
    stubSession(null);
    const { router } = await renderApp('/orders?page=2');

    expect(await screen.findByRole('heading', { name: 'Logowanie' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toBe('?returnTo=%2Forders%3Fpage%3D2');
  });

  it('anonymous visitor on an admin page goes to the login page too', async () => {
    stubSession(null);
    const { router } = await renderApp('/admin/products');

    await screen.findByRole('heading', { name: 'Logowanie' });
    expect(router.state.location.search).toBe('?returnTo=%2Fadmin%2Fproducts');
  });

  it('CUSTOMER on /admin/products sees "Brak dostępu" without a redirect', async () => {
    stubSession(['CUSTOMER']);
    const { router } = await renderApp('/admin/products');

    expect(await screen.findByRole('heading', { name: 'Brak dostępu' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/admin/products');
    expect(screen.queryByRole('link', { name: 'Panel admina' })).not.toBeInTheDocument();
  });

  it('ADMIN opens /admin/products and sees the admin link', async () => {
    stubSession(['ADMIN']);
    await renderApp('/admin/products');

    expect(await screen.findByRole('heading', { name: 'Produkty' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Panel admina' })).toBeInTheDocument();
  });

  it('/admin redirects to /admin/products', async () => {
    stubSession(['ADMIN']);
    const { router } = await renderApp('/admin');

    await screen.findByRole('heading', { name: 'Produkty' });
    expect(router.state.location.pathname).toBe('/admin/products');
  });

  it('logged-in user on /login goes to returnTo, or to / without it', async () => {
    stubSession(['CUSTOMER']);
    const { router } = await renderApp('/login?returnTo=%2Faccount');
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/account'));

    stubSession(['CUSTOMER']);
    const second = await renderApp('/register?returnTo=%2F%2Fevil.example');
    await vi.waitFor(() => expect(second.router.state.location.pathname).toBe('/'));
  });

  it('unknown address shows "Nie znaleziono strony"', async () => {
    stubSession(null);
    await renderApp('/no-such-page');

    expect(await screen.findByRole('heading', { name: 'Nie znaleziono strony' })).toBeInTheDocument();
  });
});
