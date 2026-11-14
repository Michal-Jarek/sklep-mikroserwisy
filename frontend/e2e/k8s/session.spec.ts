import { expect, test, expectLoggedIn, logIn, logOut, newAccount, registerAndLogIn } from '../compose/helpers';

// Registration and login through https://shop.localhost (Traefik Ingress with the mkcert certificate → frontend nginx
// and API Gateway in the `shop` namespace, Auth and User Service behind it). Helpers and the CSP check of the compose
// project (helpers.ts). All clients of the laptop share one address: logins in this file: 3, registrations: 2.

test('registration: a new account through the form logs in, the session cookie is Secure and survives a reload', async ({ page, context }) => {
  await registerAndLogIn(page, newAccount());
  await expect(page).toHaveURL(/^https:\/\/[^/]+\/$/);

  const refresh = (await context.cookies()).find((cookie) => cookie.name === 'refresh_token');
  expect(refresh).toMatchObject({ secure: true, httpOnly: true, sameSite: 'Strict', path: '/api/v1/auth' });

  await page.reload();
  await expectLoggedIn(page);
});

test('login: an account registered before logs out and logs in again through the form', async ({ page }) => {
  // The account is created through the form as well: the browser trusts the mkcert CA of the system, the Node side of
  // Playwright (page.request) does not.
  const account = newAccount();
  await registerAndLogIn(page, account);
  await logOut(page);

  await logIn(page, account);
  await expectLoggedIn(page);
  await page.reload();
  await expectLoggedIn(page);
});
