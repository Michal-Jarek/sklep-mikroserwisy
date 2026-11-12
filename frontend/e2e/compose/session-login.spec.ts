import { expect, test, expectLoggedIn, expectLoggedOut, logIn, logOut, newAccount, registerAndLogIn } from './helpers';

// Logins in this file: 3.
test('session: register, login, reload keeps the session, logout', async ({ page }) => {
  const account = newAccount();

  await registerAndLogIn(page, account);
  await expect(page).toHaveURL(/\/$/);
  await page.reload();
  await expectLoggedIn(page);

  await logOut(page);
  await page.reload();
  await expectLoggedOut(page);

  await logIn(page, account);
  await expectLoggedIn(page);
  await page.goto('/orders');
  await expect(page).toHaveURL(/\/orders$/);
  await page.reload();
  await expectLoggedIn(page);
  await expect(page).toHaveURL(/\/orders$/);

  await logOut(page);
  // After logout a protected page sends the visitor to the login page.
  await page.goto('/orders');
  await expect(page).toHaveURL(/\/login\?returnTo=%2Forders$/);
});

// Z19a (C2): POST /auth/logout without 204 (here a 503 from page.route, so Auth never gets it) must not look
// like a logout: the refresh cookie is still valid. Only the exact message counts — on "/" the catalog shows
// its own alert (Product is not in compose).
test('session: failed logout keeps the session with a message, the next try logs out', async ({ page }) => {
  await registerAndLogIn(page, newAccount());

  await page.route('**/api/v1/auth/logout', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ status: 503, error: 'SERVICE_UNAVAILABLE', message: 'Service unavailable', requestId: 'e2e-503' }),
    }),
  );
  await page.getByRole('button', { name: 'Wyloguj' }).click();
  await expect(page.getByText('Nie udało się wylogować. Spróbuj ponownie za chwilę.', { exact: true })).toBeVisible();
  await expectLoggedIn(page);
  await page.reload();
  await expectLoggedIn(page);

  await page.unroute('**/api/v1/auth/logout');
  const logoutResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/logout'));
  await logOut(page);
  expect((await logoutResponse).status()).toBe(204);
  // Auth revoked the refresh token: after a reload the visitor stays anonymous.
  await page.reload();
  await expectLoggedOut(page);
});
