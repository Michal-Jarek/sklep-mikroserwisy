import { expect, test, expectLoggedIn, newAccount, registerAndLogIn } from './helpers';

// Logins in this file: 1. Both tabs share the refresh cookie; without the Web Lock the second refresh
// would reuse a rotated token and Auth would end the session ("Refresh token reuse detected", K34).
test('session: two tabs reloaded at once stay logged in', async ({ context, page }) => {
  await registerAndLogIn(page, newAccount());
  // From here on (the start-up refresh before registration answered 401, as for every anonymous visitor).
  const refreshStatuses: number[] = [];
  context.on('response', (response) => {
    if (response.url().endsWith('/api/v1/auth/refresh')) refreshStatuses.push(response.status());
  });
  const second = await context.newPage();
  await second.goto('/');
  await expectLoggedIn(second);

  for (let round = 0; round < 2; round++) {
    await Promise.all([page.reload(), second.reload()]);
    await expectLoggedIn(page);
    await expectLoggedIn(second);
  }

  // Start-up of the second tab + two rounds of two tabs: five refreshes, all accepted.
  expect(refreshStatuses).toEqual([200, 200, 200, 200, 200]);
});
