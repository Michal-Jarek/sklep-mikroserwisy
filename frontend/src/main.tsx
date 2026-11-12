import '@/lib/zod-setup';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/app/App';
import '@/index.css';

// Mocks (MSW) only in `vite` dev mode with VITE_API_MOCKS; the production build drops this branch
// together with src/mocks (K3).
if (import.meta.env.DEV && import.meta.env.VITE_API_MOCKS) {
  const { startMocks } = await import('./mocks/browser');
  await startMocks(import.meta.env.VITE_API_MOCKS);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
