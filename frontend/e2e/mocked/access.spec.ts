import { expect, test, type Page } from '@playwright/test';
import { login, MOCK_ACCOUNTS, resetMocks, SEED_IDS } from '../support/mocks';

/** Fills the login form that the guard opened, so the app goes back to returnTo. */
async function logInHere(page: Page, role: 'customer' | 'admin') {
  await page.getByLabel('E-mail', { exact: true }).fill(MOCK_ACCOUNTS[role].email);
  await page.getByLabel('Hasło', { exact: true }).fill(MOCK_ACCOUNTS[role].password);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
}

async function logOut(page: Page) {
  await page.getByRole('button', { name: 'Wyloguj' }).click();
  await expect(page.getByRole('link', { name: 'Zaloguj', exact: true })).toBeVisible();
}

test('access: customer cannot open admin pages and anonymous goes to login', async ({ page }) => {
  await resetMocks(page);
  const nav = page.getByRole('navigation', { name: 'Konto' });

  // CUSTOMER: "Brak dostępu" on the same address, no link to the panel.
  await login(page, 'customer');
  await expect(nav.getByRole('link', { name: 'Zamówienia' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Panel admina' })).toHaveCount(0);
  for (const path of ['/admin/products', '/admin/shipments', '/admin/products/new']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'Brak dostępu' })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
  }
  await logOut(page);

  // Anonymous on protected pages → login with returnTo, back after logging in.
  await page.goto('/admin/products');
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fadmin%2Fproducts$/);
  await logInHere(page, 'admin');
  await expect(page).toHaveURL(/\/admin\/products$/);
  await expect(page.getByRole('heading', { name: 'Produkty', level: 1 })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Panel admina' })).toBeVisible();
  await logOut(page);

  await page.goto('/cart');
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fcart$/);
  await logInHere(page, 'customer');
  await expect(page).toHaveURL(/\/cart$/);
  await logOut(page);

  await page.goto('/orders');
  await expect(page).toHaveURL(/\/login\?returnTo=%2Forders$/);
  await logInHere(page, 'customer');
  await expect(page).toHaveURL(/\/orders$/);
  await logOut(page);

  // Anonymous "Dodaj do koszyka" → login, then back on the product.
  const productPath = `/products/${SEED_IDS.products.regular}`;
  await page.goto(productPath);
  await page.getByRole('button', { name: 'Dodaj do koszyka' }).click();
  await expect(page).toHaveURL(new RegExp(`/login\\?returnTo=${encodeURIComponent(productPath)}$`));
  await logInHere(page, 'customer');
  await expect(page).toHaveURL(new RegExp(`${productPath}$`));
  await expect(page.getByRole('heading', { name: 'Kubek ceramiczny', level: 1 })).toBeVisible();
});
