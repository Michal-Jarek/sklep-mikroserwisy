import { expect, test, expectLoggedOut } from './helpers';

// Start-up with Auth stopped (wytyczne 6b 3.9 and 3.10, K27): the Gateway answers the refresh with 5xx (502 for up to
// 10 s after the stop, then 503), so the app sends one more refresh 2.5 s later and then stays anonymous without a
// message. Playwright in a container cannot stop Auth: run this file only with Auth stopped and E2E_AUTH_STOPPED=1
// (frontend README, "Testy E2E"). No login in this file.
const REFRESH_PATH = '/api/v1/auth/refresh';

test('auth unavailable: start-up retries the refresh once and stays anonymous without a message', async ({ page }) => {
  test.skip(process.env.E2E_AUTH_STOPPED !== '1', 'needs auth-service stopped and E2E_AUTH_STOPPED=1 (frontend README)');

  const refreshes: number[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === REFRESH_PATH) refreshes.push(Date.now());
  });

  await page.goto('/');

  await expect(page.getByRole('list', { name: 'Produkty' }).getByRole('listitem').first()).toBeVisible();
  // The second refresh comes 2.5 s after the first one answered; with Auth killed (not deregistered) that answer can be late.
  await expect.poll(() => refreshes.length, { timeout: 10_000 }).toBe(2);
  await expectLoggedOut(page);
  // No third refresh after the start-up has finished.
  await page.waitForTimeout(3000);
  expect(refreshes).toHaveLength(2);
  expect(refreshes[1] - refreshes[0]).toBeGreaterThanOrEqual(2000);
  await expect(page.getByText('Sesja wygasła', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
