// Helpers for E2E tests of the project `mocked` (dev server with VITE_API_MOCKS=all).
// The mocks answer inside the page (MSW service worker), so page.route does not see these requests:
// errors are planned through window.__mocks instead.
import { expect, type Page } from '@playwright/test';
import type { FailNextOptions } from '../../src/mocks/controls';
import { MOCK_ACCOUNTS } from '../../src/mocks/seed';

export { MOCK_ACCOUNTS, SEED_IDS } from '../../src/mocks/seed';

async function waitForMocks(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__mocks !== undefined);
}

/** Logs in through the form on /login with a mock account (klient@sklep.test or admin@sklep.test). */
export async function login(page: Page, role: 'customer' | 'admin'): Promise<void> {
  const account = MOCK_ACCOUNTS[role];
  await page.goto('/login');
  await waitForMocks(page);
  await page.getByLabel('E-mail', { exact: true }).fill(account.email);
  await page.getByLabel('Hasło', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await expect(page).not.toHaveURL(/\/login(\?|$)/);
}

/** Seed data, no session, no planned errors; then reloads the page. */
export async function resetMocks(page: Page): Promise<void> {
  if (page.url() === 'about:blank') {
    await page.goto('/');
  }
  await waitForMocks(page);
  await page.evaluate(() => window.__mocks?.reset());
  await page.reload();
  await waitForMocks(page);
}

/**
 * The next `opts.times` (default 1) requests to `resource` (first path segment after /api/v1) get `status`.
 * Every request that reaches the mocks counts, also an aborted one. To show a 502/503/504 for a GET:
 * `times: 2` for a later GET (client retry), `times: 3` for a GET on page entry (StrictMode sends it twice,
 * the aborted one counts too). Details: src/mocks/controls.ts.
 */
export async function failNext(page: Page, resource: string, status: number, opts: FailNextOptions = {}): Promise<void> {
  await waitForMocks(page);
  await page.evaluate(([r, s, o]) => window.__mocks?.failNext(r, s, o), [resource, status, opts] as const);
}
