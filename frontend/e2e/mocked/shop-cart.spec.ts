import { expect, test } from '@playwright/test';
import { MOCK_ACCOUNTS, resetMocks, SEED_IDS } from '../support/mocks';

const { products } = SEED_IDS;

test('cart: login required, add, change, remove, unchecked availability note', async ({ page }) => {
  await resetMocks(page);
  const cartLink = page.getByRole('link', { name: /^Koszyk/ });

  // Anonymous: the cart page and "Dodaj do koszyka" lead to the login page, then back to the product
  await page.goto('/cart');
  await expect(page).toHaveURL(/\/login\?returnTo=%2Fcart$/);
  await page.goto(`/products/${products.regular}`);
  await page.getByRole('button', { name: 'Dodaj do koszyka' }).click();
  await expect(page).toHaveURL(new RegExp(`/login\\?returnTo=${encodeURIComponent(`/products/${products.regular}`)}$`));
  await page.getByLabel('E-mail', { exact: true }).fill(MOCK_ACCOUNTS.customer.email);
  await page.getByLabel('Hasło', { exact: true }).fill(MOCK_ACCOUNTS.customer.password);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await expect(page).toHaveURL(new RegExp(`/products/${products.regular}$`));

  // Add two products; the one without stock data gets the note
  await page.getByRole('button', { name: 'Dodaj do koszyka' }).click();
  await expect(page.getByText('Produkt jest w koszyku.')).toBeVisible();
  await expect(cartLink).toHaveText(/Koszyk\s*1/);
  await page.goto(`/products/${products.noStock}`);
  await page.getByRole('button', { name: 'Dodaj do koszyka' }).click();
  await expect(page.getByText('Magazyn nie odpowiedział — dostępność sprawdzimy przy zamówieniu.')).toBeVisible();
  await expect(cartLink).toHaveText(/Koszyk\s*2/);

  // Change quantities
  await cartLink.click();
  await expect(page).toHaveURL(/\/cart$/);
  const items = page.getByRole('list', { name: 'Pozycje koszyka' }).getByRole('listitem');
  await expect(items).toHaveCount(2);
  await page.getByRole('textbox', { name: 'Ilość: Kubek ceramiczny' }).fill('3');
  await page.getByRole('button', { name: 'Zmień ilość: Kubek ceramiczny' }).click();
  await expect(items.filter({ hasText: 'Kubek ceramiczny' })).toContainText(/59,97\s*zł/);
  await expect(page.getByText('Dostępność sprawdzimy przy zamówieniu', { exact: true })).toBeHidden();
  await page.getByRole('textbox', { name: 'Ilość: Młynek do kawy' }).fill('2');
  await page.getByRole('button', { name: 'Zmień ilość: Młynek do kawy' }).click();
  await expect(page.getByText('Dostępność sprawdzimy przy zamówieniu', { exact: true })).toBeVisible();
  await expect(page.getByText(/^Suma:/)).toContainText(/239,95\s*zł/);

  // Remove both; an empty cart cannot be ordered
  await page.getByRole('button', { name: 'Usuń: Młynek do kawy' }).click();
  await expect(items).toHaveCount(1);
  await expect(page.getByText(/^Suma:/)).toContainText(/59,97\s*zł/);
  await page.getByRole('button', { name: 'Usuń: Kubek ceramiczny' }).click();
  await expect(page.getByText('Koszyk jest pusty.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Przejdź do zamówienia' })).toBeDisabled();
  await expect(cartLink).toHaveText(/Koszyk\s*0/);
});
