import { expect, test, logIn, logOut, newAccount, registerAndLogIn } from './helpers';

// Logins in this file: 6 on purpose (decision Z3): the 6th login within a minute gets the real
// 429 TOO_MANY_REQUESTS of the Gateway with Retry-After. The pw container has its own IP.
// TOO_MANY_ATTEMPTS (account lock after 10 failures) cannot be reached under this limit: Vitest covers it.
test('auth errors: wrong password, e-mail taken, too many attempts', async ({ page }) => {
  const account = newAccount();
  await registerAndLogIn(page, account); // login 1
  await logOut(page);

  await page.goto('/register');
  await page.getByLabel('Imię', { exact: true }).fill(account.firstName);
  await page.getByLabel('Nazwisko', { exact: true }).fill(account.lastName);
  await page.getByLabel('E-mail', { exact: true }).fill(account.email);
  await page.getByLabel('Hasło', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Załóż konto' }).click();
  await expect(page.getByText('Konto z tym adresem e-mail już istnieje.')).toBeVisible();

  const wrong = { email: account.email, password: 'Zle-haslo-12345' };
  for (let attempt = 2; attempt <= 5; attempt++) {
    await logIn(page, wrong);
    await expect(page.getByText('Nieprawidłowy e-mail lub hasło.')).toBeVisible();
  }

  await logIn(page, wrong); // login 6
  await expect(page.getByText(/^Zbyt wiele prób\. Spróbuj ponownie za \d+ s\.$/)).toBeVisible();
  await expect(page.getByText(/^Kod zgłoszenia: /)).toBeVisible();
});
