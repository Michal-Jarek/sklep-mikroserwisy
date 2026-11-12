import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { server, setupMockServer } from '@/mocks/node';
import { MOCK_ACCOUNTS } from '@/mocks/seed';
import { renderApp } from '@/test/render-app';

setupMockServer();

const LOGOUT_FAILED = 'Nie udało się wylogować. Spróbuj ponownie za chwilę.';

describe('header: logout (C2, Z19a)', () => {
  it('a failed logout keeps the session and shows the message; the next try logs out', async () => {
    const { router } = await renderApp('/login');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('E-mail', { exact: true }), MOCK_ACCOUNTS.customer.email);
    await user.type(screen.getByLabelText('Hasło', { exact: true }), MOCK_ACCOUNTS.customer.password);
    await user.click(screen.getByRole('button', { name: 'Zaloguj się' }));
    await user.click(await screen.findByRole('link', { name: 'Moje konto' }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/account'));

    server.use(http.post('*/api/v1/auth/logout', () => HttpResponse.json({ status: 503, error: 'SERVICE_UNAVAILABLE', message: 'test', requestId: 'rid-503' }, { status: 503 }), { once: true }));
    await user.click(screen.getByRole('button', { name: 'Wyloguj' }));

    expect(await screen.findByText(LOGOUT_FAILED)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Wyloguj' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/account');

    await user.click(screen.getByRole('button', { name: 'Wyloguj' }));

    expect(await screen.findByRole('link', { name: 'Zaloguj' })).toBeInTheDocument();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });
});
