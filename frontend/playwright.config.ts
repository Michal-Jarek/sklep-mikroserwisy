import { defineConfig, devices } from '@playwright/test';

// Three projects (wytyczne 3.9 of stages 6 and 7):
// - mocked: Vite dev server with all mocks (VITE_API_MOCKS=all), started by Playwright;
// - compose: the `frontend` image with the real Gateway and Auth (E2E_BASE_URL, default below),
//   no Vite server;
// - k8s: the shop in the `shop` namespace through Ingress and TLS (E2E_K8S_URL, default below); the mkcert CA is
//   trusted by the system (`mkcert -install`), so no ignoreHTTPSErrors.

const MOCKED_PORT = 5174;
const MOCKED_URL = `http://127.0.0.1:${MOCKED_PORT}`;
const COMPOSE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8090';
const K8S_URL = process.env.E2E_K8S_URL ?? 'https://shop.localhost';

/** Values of a command line option (`--project x` or `--project=x`). */
function cliValues(option: string): string[] {
  const argv = process.argv;
  return argv.flatMap((arg, i) => (arg === option ? [argv[i + 1]] : arg.startsWith(`${option}=`) ? [arg.slice(option.length + 1)] : []));
}

const projects = cliValues('--project');
const runsMocked = projects.length === 0 || projects.includes('mocked');
// `--output <dir>` from the command line (function `pw`): the HTML report goes next to it.
const outputDir = cliValues('--output')[0];

// Chromium allows Secure cookies, Web Locks and crypto.randomUUID only in a secure context; plain http is
// one only on localhost/127.0.0.1. In the `pw` container the app is http://frontend:8080, so that origin is
// marked as secure (decision Z4). The default headless shell ignores this flag; the full Chromium
// (channel "chromium", new headless mode, part of the Playwright image) honours it.
const composeUrl = new URL(COMPOSE_URL);
const composeIsLocalhost = composeUrl.hostname === 'localhost' || composeUrl.hostname === '127.0.0.1';

export default defineConfig({
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: outputDir ? `${outputDir}-report` : 'playwright-report' }]],
  use: {
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'mocked',
      testDir: 'e2e/mocked',
      use: { ...devices['Desktop Chrome'], baseURL: MOCKED_URL },
    },
    {
      name: 'compose',
      testDir: 'e2e/compose',
      // Login limit 5/min/IP: files of this project never run at the same time.
      workers: 1,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: COMPOSE_URL,
        ...(composeIsLocalhost ? {} : { channel: 'chromium', launchOptions: { args: [`--unsafely-treat-insecure-origin-as-secure=${composeUrl.origin}`] } }),
      },
    },
    {
      name: 'k8s',
      testDir: 'e2e/k8s',
      // One address for all clients of the laptop (Rancher Desktop port forwarding): login limit 5/min for the project.
      workers: 1,
      use: { ...devices['Desktop Chrome'], baseURL: K8S_URL, channel: 'chromium' },
    },
  ],
  webServer: runsMocked
    ? {
        command: `npm run dev:mocks -- --port ${MOCKED_PORT}`,
        url: MOCKED_URL,
        reuseExistingServer: false,
        timeout: 60_000,
      }
    : undefined,
});
