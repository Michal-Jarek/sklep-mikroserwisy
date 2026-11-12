import { createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { loadEnv, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);

// Serves the MSW worker script from node_modules during `vite` (dev) only (U3),
// so it is never in public/ or in the production build.
function mswWorker(): Plugin {
  const workerFile = require.resolve('msw/mockServiceWorker.js');
  return {
    name: 'msw-worker',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/mockServiceWorker.js', (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript');
        res.setHeader('Cache-Control', 'no-store');
        createReadStream(workerFile).pipe(res);
      });
    },
  };
}

export default defineConfig(({ command, mode }) => {
  // VITE_API_MOCKS: the production build is always without mocks; `--mode mocks` (npm run dev:mocks) means "all".
  // Vite reads process.env after this function, and process.env wins over .env files.
  if (command === 'build') process.env.VITE_API_MOCKS = '';
  else if (mode === 'mocks') process.env.VITE_API_MOCKS = 'all';

  // Target of the /api proxy of the dev server; read by Node only, never sent to the browser.
  const apiProxyTarget = process.env.API_PROXY_TARGET || loadEnv(mode, import.meta.dirname, '').API_PROXY_TARGET || 'http://127.0.0.1:8080';
  const proxy = { '/api': { target: apiProxyTarget } };

  return {
    plugins: [react(), tailwindcss(), mswWorker()],
    resolve: {
      alias: { '@': path.resolve(import.meta.dirname, 'src') },
    },
    server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy },
    build: { sourcemap: false },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      env: { TZ: 'Europe/Warsaw' },
      restoreMocks: true,
      unstubGlobals: true,
    },
  };
});
