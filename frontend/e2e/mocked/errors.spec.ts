import { expect, test } from '@playwright/test';
import { failNext, MOCK_ACCOUNTS, resetMocks, SEED_IDS } from '../support/mocks';

test('errors: unavailable service shows a message with retry and the app keeps working', async ({ page }) => {
  await resetMocks(page);

  // Review down. Three planned errors: in the dev server <StrictMode> mounts the page twice, so TanStack Query
  // aborts the first GET and sends it again (the aborted request still reaches the mock and uses one error);
  // the third covers the client's single retry of the GET (decision 12). Without the double request the
  // message shows after two errors and "Spróbuj ponownie" uses the third, then its retry succeeds.
  await failNext(page, 'reviews', 503, { times: 3 });
  await page.goto(`/products/${SEED_IDS.products.regular}`);

  const reviews = page.getByRole('region', { name: 'Opinie' });
  await expect(reviews.getByText('Usługa jest chwilowo niedostępna. Spróbuj ponownie za chwilę.')).toBeVisible();
  await expect(reviews.getByText(/^Kod zgłoszenia: \S+/)).toBeVisible();

  // The rest of the page works.
  await expect(page.getByRole('heading', { name: 'Kubek ceramiczny', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dodaj do koszyka' })).toBeEnabled();

  await reviews.getByRole('button', { name: 'Spróbuj ponownie' }).click();
  await expect(reviews.getByRole('list', { name: 'Lista opinii' }).getByRole('listitem')).toHaveCount(10);
  await expect(reviews.getByText('Kod zgłoszenia', { exact: false })).toHaveCount(0);

  // Navigation still works.
  await page.getByRole('link', { name: 'Sklep', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Katalog' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Produkty' }).getByRole('listitem').first()).toBeVisible();
});

test('errors: too many login attempts shows the wait time', async ({ page }) => {
  await resetMocks(page);
  await page.goto('/login');
  const email = page.getByLabel('E-mail', { exact: true });
  // The form shows after the start-up POST /auth/refresh, so the planned errors hit the login requests.
  await expect(email).toBeVisible();
  await email.fill(MOCK_ACCOUNTS.customer.email);
  await page.getByLabel('Hasło', { exact: true }).fill(MOCK_ACCOUNTS.customer.password);
  const submit = page.getByRole('button', { name: 'Zaloguj się' });

  // Gateway limit: 429 TOO_MANY_REQUESTS with Retry-After in seconds.
  await failNext(page, 'auth', 429, { retryAfter: 30 });
  await submit.click();
  await expect(page.getByText('Zbyt wiele prób. Spróbuj ponownie za 30 s.')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);

  // Auth account lock: TOO_MANY_ATTEMPTS, 840 s → 14 min.
  await failNext(page, 'auth', 429, { error: 'TOO_MANY_ATTEMPTS', retryAfter: 840 });
  await submit.click();
  await expect(page.getByText('Konto jest czasowo zablokowane. Spróbuj ponownie za 14 min.')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);

  // No more planned errors: the same form logs in.
  await submit.click();
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByRole('button', { name: 'Wyloguj' })).toBeVisible();
});
