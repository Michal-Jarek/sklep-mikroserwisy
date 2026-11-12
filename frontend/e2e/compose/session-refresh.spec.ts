import { expect, test, expectLoggedIn, newAccount, registerAndLogIn } from './helpers';

// Logins in this file: 1.
test('session: expired access token is refreshed and the request repeated', async ({ page }) => {
  await registerAndLogIn(page, newAccount());

  // Order of the calls that matter, without token values (they must not end up in test output).
  const calls: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/users/me') calls.push(request.headers().authorization?.startsWith('Bearer ') ? 'profile with token' : 'profile without token');
    if (path === '/api/v1/auth/refresh') calls.push('refresh');
  });
  // The first request with a token gets 401 as if the access token had expired; later ones go to the Gateway.
  let rejected = false;
  await page.route('**/api/v1/users/me', async (route) => {
    if (!rejected && route.request().headers().authorization) {
      rejected = true;
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        headers: { 'WWW-Authenticate': 'Bearer' },
        body: JSON.stringify({ status: 401, error: 'UNAUTHORIZED', message: 'Missing or invalid access token', requestId: 'e2e-401' }),
      });
      return;
    }
    await route.continue();
  });
  const refreshed = page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/refresh'));

  await page.getByRole('link', { name: 'Moje konto' }).click();

  expect((await refreshed).status()).toBe(200);
  // User Service is not in compose yet, so after the repeat the page shows the unavailable message (not the login page).
  await expect(page.getByText('Usługa jest chwilowo niedostępna. Spróbuj ponownie za chwilę.')).toBeVisible();
  await expect(page).toHaveURL(/\/account$/);
  await expectLoggedIn(page);

  // 401 → one refresh → the same request again with a token (then one more GET retry after the 503 of the Gateway).
  expect(rejected).toBe(true);
  expect(calls.slice(0, 3)).toEqual(['profile with token', 'refresh', 'profile with token']);
  expect(calls.filter((call) => call === 'refresh')).toHaveLength(1);
});
