import { expect, test, expectLoggedIn, newAccount, registerAndLogIn } from './helpers';

// Logins in this file: 1.
test('session: no tokens in web storage or readable cookies', async ({ context, page }) => {
  const loginResponse = page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/login') && response.status() === 200);
  await registerAndLogIn(page, newAccount());
  const { accessToken } = (await (await loginResponse).json()) as { accessToken: string };
  await page.reload();
  await expectLoggedIn(page);

  // Z4: the page runs in a secure context (Secure cookie, Web Locks), also on http://frontend:8080 in the pw container.
  const browserState = await page.evaluate(async () => ({
    secure: window.isSecureContext,
    locks: 'locks' in navigator,
    local: JSON.stringify({ ...localStorage }),
    session: JSON.stringify({ ...sessionStorage }),
    cookie: document.cookie,
    databases: (await indexedDB.databases()).length,
  }));
  expect(browserState.secure).toBe(true);
  expect(browserState.locks).toBe(true);
  expect(browserState.local).toBe('{}');
  expect(browserState.session).toBe('{}');
  expect(browserState.databases).toBe(0);
  expect(browserState.cookie).not.toContain('refresh_token');
  for (const value of [browserState.local, browserState.session, browserState.cookie]) {
    expect(value).not.toContain(accessToken.split('.')[1]);
  }

  // The refresh token is only in the httpOnly cookie of Auth.
  const refreshCookie = (await context.cookies()).find((cookie) => cookie.name === 'refresh_token');
  expect(refreshCookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/api/v1/auth' });
  expect((await context.cookies()).filter((cookie) => !cookie.httpOnly)).toEqual([]);
});
