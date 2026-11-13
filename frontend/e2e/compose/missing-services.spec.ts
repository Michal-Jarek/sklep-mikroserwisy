import { expect, test, newAccount, registerAndLogIn } from './helpers';

// Order and Shipping are not in compose yet: they are not registered in Consul, so the Gateway answers
// 503 SERVICE_UNAVAILABLE (the client repeats a GET once after 503, decision 12 of stage 6, then shows the message).
// The checkout needs a non-empty cart; precondition as in shop-flow.spec.ts (stock set by `bash postman/run.sh compose`).
// CSP violations are collected by the `cspViolations` fixture of helpers.ts (every compose test).
// Logins in this file: 1.
const UNAVAILABLE = 'Usługa jest chwilowo niedostępna. Spróbuj ponownie za chwilę.';
const ALGORYTMY = 'a0000000-0000-4000-8000-000000000010';

test('missing services: orders and shipping methods show the unavailable message, the catalog works', async ({ page }) => {
  await registerAndLogIn(page, newAccount());

  // Catalog (Product) works.
  await page.goto('/');
  await expect(page.getByRole('list', { name: 'Produkty' }).getByRole('listitem').first()).toBeVisible();

  // Order history (Order Service).
  await page.getByRole('link', { name: 'Zamówienia' }).click();
  await expect(page).toHaveURL(/\/orders$/);
  await expect(page.getByText(UNAVAILABLE)).toBeVisible();
  await expect(page.getByText(/^Kod zgłoszenia: \S+/)).toBeVisible();

  // Shipping methods in the checkout (Shipping Service); the rest of the checkout is shown.
  await page.goto(`/products/${ALGORYTMY}`);
  await page.getByRole('button', { name: 'Dodaj do koszyka' }).click();
  await expect(page.getByText('Produkt jest w koszyku.')).toBeVisible();
  await page.goto('/checkout');
  await expect(page.getByRole('heading', { name: '1. Adres dostawy' })).toBeVisible();
  await expect(page.getByText(UNAVAILABLE)).toBeVisible();
  await expect(page.getByText(/^Kod zgłoszenia: \S+/)).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Sposób dostawy' })).toHaveCount(0);
});
