// Helpers of the `compose` project (real Auth and Gateway). Every test creates its own account with a
// unique e-mail. Login limit: 5 per minute per IP in the Gateway and in Auth, so a file logs in at most 4 times.
import { test as base, expect, type Page } from '@playwright/test';

export { expect };

/**
 * `test` of the compose project: every page of every test is watched for CSP violations from the first
 * request on (nginx sends the CSP of wytyczne 3.2), and the test fails when there is one.
 */
export const test = base.extend<{ cspViolations: string[] }>({
  cspViolations: [
    async ({ context }, use) => {
      const violations: string[] = [];
      await context.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (event) => {
          console.error(`Content Security Policy violation: ${event.violatedDirective} ${event.blockedURI}`);
        });
      });
      context.on('console', (message) => {
        if (message.text().includes('Content Security Policy')) violations.push(message.text());
      });
      context.on('weberror', (error) => {
        if (error.error().message.includes('Content Security Policy')) violations.push(error.error().message);
      });
      await use(violations);
      expect(violations, 'CSP violations').toEqual([]);
    },
    { auto: true },
  ],
});

export interface TestAccount {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
}

export function newAccount(): TestAccount {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Test-only password of a throwaway account, not a secret.
  return { firstName: 'Test', lastName: 'E2E', email: `e2e-${id}@example.com`, password: `Haslo-${id}` };
}

export async function expectLoggedIn(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Wyloguj' })).toBeVisible();
}

export async function expectLoggedOut(page: Page): Promise<void> {
  await expect(page.getByRole('link', { name: 'Zaloguj', exact: true })).toBeVisible();
}

/** Registration through the form; the app then logs in with the same data (one login). */
export async function registerAndLogIn(page: Page, account: TestAccount): Promise<void> {
  await page.goto('/register');
  await page.getByLabel('Imię', { exact: true }).fill(account.firstName);
  await page.getByLabel('Nazwisko', { exact: true }).fill(account.lastName);
  await page.getByLabel('E-mail', { exact: true }).fill(account.email);
  await page.getByLabel('Hasło', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Załóż konto' }).click();
  await expectLoggedIn(page);
}

export async function logIn(page: Page, account: Pick<TestAccount, 'email' | 'password'>): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('E-mail', { exact: true }).fill(account.email);
  await page.getByLabel('Hasło', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
}

export async function logOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Wyloguj' }).click();
  await expectLoggedOut(page);
}
