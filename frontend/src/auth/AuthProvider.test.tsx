// C5: variables of mutations (password of the login form) do not stay in the MutationCache.
import type { QueryClient } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { setupMockServer } from '@/mocks/node';
import { MOCK_ACCOUNTS } from '@/mocks/seed';
import { createTestBroadcastChannel } from '@/test/broadcast-channel';

setupMockServer();

/** The whole app like src/test/render-app.tsx, but the test keeps the QueryClient to read its MutationCache. */
async function renderAppWithClient(path: string, makeClient?: (createQueryClient: () => QueryClient) => QueryClient) {
  vi.resetModules();
  vi.stubGlobal('BroadcastChannel', createTestBroadcastChannel());
  const { routes } = await import('@/app/router');
  const { Providers } = await import('@/app/providers');
  const { createQueryClient } = await import('@/api/query-client');
  const queryClient = makeClient ? makeClient(createQueryClient) : createQueryClient();
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <Providers queryClient={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, queryClient };
}

async function logInThroughForm() {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('E-mail', { exact: true }), MOCK_ACCOUNTS.customer.email);
  await user.type(screen.getByLabelText('Hasło', { exact: true }), MOCK_ACCOUNTS.customer.password);
  await user.click(screen.getByRole('button', { name: 'Zaloguj się' }));
  return user;
}

const mutationVariables = (queryClient: QueryClient) => JSON.stringify(queryClient.getMutationCache().getAll().map((mutation) => mutation.state.variables));

describe('mutation cache and the session (C5)', () => {
  it('after logging in through the form and going on, the MutationCache has no password', async () => {
    const { router, queryClient } = await renderAppWithClient(`/login?returnTo=${encodeURIComponent('/account')}`);

    await logInThroughForm();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/account'));
    await screen.findByRole('button', { name: 'Wyloguj' });

    await vi.waitFor(() => expect(mutationVariables(queryClient)).not.toContain(MOCK_ACCOUNTS.customer.password));
    expect(queryClient.getMutationCache().getAll()).toEqual([]);
  });

  it('a change of the user clears the MutationCache even when mutations would be kept longer', async () => {
    // gcTime of mutations as before C5 (5 min): only the AuthProvider removes them.
    const { router, queryClient } = await renderAppWithClient(`/login?returnTo=${encodeURIComponent('/account')}`, (createQueryClient) => {
      const client = createQueryClient();
      client.setDefaultOptions({ ...client.getDefaultOptions(), mutations: { retry: false, gcTime: 5 * 60_000 } });
      return client;
    });

    const user = await logInThroughForm();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/account'));
    await vi.waitFor(() => expect(mutationVariables(queryClient)).not.toContain(MOCK_ACCOUNTS.customer.password));

    // A mutation of the logged-in user (e.g. an order with a card number) is gone after the logout too.
    const order = queryClient.getMutationCache().build(queryClient, { mutationFn: (variables: unknown) => Promise.resolve(variables) });
    await order.execute({ payment: { cardNumber: '4111111111111111' } });
    expect(mutationVariables(queryClient)).toContain('4111111111111111');
    await user.click(screen.getByRole('button', { name: 'Wyloguj' }));
    await screen.findByRole('link', { name: 'Zaloguj' });

    await vi.waitFor(() => expect(queryClient.getMutationCache().getAll()).toEqual([]));
  });
});
