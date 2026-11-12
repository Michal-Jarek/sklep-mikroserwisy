// Renders the whole app (router with all routes, providers) at a path, for page tests.
// Modules are loaded fresh, so every test starts with no session (one refresh at start-up, like a new tab).
import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';
import { createTestBroadcastChannel } from '@/test/broadcast-channel';

export async function renderApp(path: string) {
  vi.resetModules();
  // Session modules of earlier tests keep their BroadcastChannel open; a fresh channel class isolates them.
  vi.stubGlobal('BroadcastChannel', createTestBroadcastChannel());
  const { routes } = await import('@/app/router');
  const { Providers } = await import('@/app/providers');
  const { createQueryClient } = await import('@/api/query-client');
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const view = render(
    <Providers queryClient={createQueryClient()}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { router, ...view };
}
