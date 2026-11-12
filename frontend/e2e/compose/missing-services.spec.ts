import { expect, test } from './helpers';

// No login. Product Service is not in compose yet: the Gateway answers 503 SERVICE_UNAVAILABLE.
// CSP violations are collected by the `cspViolations` fixture of helpers.ts (every compose test).
test('missing services: catalog shows the unavailable message without CSP violations', async ({ page, cspViolations }) => {
  await page.goto('/');

  await expect(page.getByText('Usługa jest chwilowo niedostępna. Spróbuj ponownie za chwilę.')).toBeVisible();
  await expect(page.getByText(/^Kod zgłoszenia: /)).toBeVisible();
  await page.getByRole('button', { name: 'Spróbuj ponownie' }).click();
  await expect(page.getByText('Usługa jest chwilowo niedostępna. Spróbuj ponownie za chwilę.')).toBeVisible();

  // The rest of the app keeps working: the login page with the form (Radix/sonner styles under the CSP).
  await page.getByRole('link', { name: 'Zaloguj', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Zaloguj się' })).toBeVisible();

  expect(cspViolations).toEqual([]);
});
