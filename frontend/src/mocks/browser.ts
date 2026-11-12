// Mocks in the browser (dev server only; src/main.tsx imports this file only when VITE_API_MOCKS is set).
// mode `all`: every endpoint including Auth; an unhandled /api/ request is an error.
// mode `users,cart,products`: only these first path segments; everything else goes to the real Gateway.
import { setupWorker } from 'msw/browser';
import { enableLocalStorage, mockConfig } from './db';
import { mockControls } from './controls';
import { handlers, resourceOf } from './handlers';

export async function startMocks(mode: string): Promise<void> {
  const all = mode.trim() === 'all';
  const resources = new Set(mode.split(',').map((r) => r.trim()).filter(Boolean));
  const active = all ? handlers : handlers.filter((h) => resources.has(resourceOf(h)));

  enableLocalStorage();
  mockConfig.delayMs = [100, 300];
  mockConfig.shipmentDelayMs = 3000;

  const worker = setupWorker(...active);
  await worker.start({
    serviceWorker: { url: '/mockServiceWorker.js' },
    quiet: true,
    onUnhandledFrame: all
      ? async ({ frame, defaults }) => {
          const data = frame.data as { request?: Request };
          if (frame.protocol === 'http' && data.request && new URL(data.request.url).pathname.startsWith('/api/')) {
            // defaults.error() only prints the message; throwing fails the request (MSW 3).
            await defaults.error();
            throw new Error(`No mock for ${data.request.method} ${data.request.url}`);
          }
        }
      : 'bypass',
  });
  window.__mocks = mockControls;
}
