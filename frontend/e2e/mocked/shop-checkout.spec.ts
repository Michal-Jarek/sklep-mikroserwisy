import { expect, test, type Page } from '@playwright/test';
import { login, resetMocks, SEED_IDS } from '../support/mocks';

const { products } = SEED_IDS;

async function addToCart(page: Page, productId: string) {
  await page.goto(`/products/${productId}`);
  await page.getByRole('button', { name: 'Dodaj do koszyka' }).click();
  await expect(page.getByText('Produkt jest w koszyku.')).toBeVisible();
}

async function fillCheckout(page: Page, method: RegExp, cardNumber: string) {
  await expect(page.getByRole('heading', { name: '1. Adres dostawy' })).toBeVisible();
  // The saved address and the names come from the profile
  await expect(page.getByLabel('ul. Testowa 1, 00-001 Warszawa, PL')).toBeChecked();
  await expect(page.getByLabel('Imię')).toHaveValue('Jan');
  await page.getByLabel(method).check();
  await expect(page.getByText('Płatność testowa: karta kończąca się cyfrą 0 zostanie odrzucona')).toBeVisible();
  await page.getByLabel('Numer karty').fill(cardNumber);
}

test('checkout: paid order empties the cart and appears in history', async ({ page }) => {
  await resetMocks(page);
  await login(page, 'customer');
  await addToCart(page, products.regular);

  await page.getByRole('link', { name: /^Koszyk/ }).click();
  await page.getByRole('link', { name: 'Przejdź do zamówienia' }).click();
  await expect(page).toHaveURL(/\/checkout$/);
  await fillCheckout(page, /^Kurier/, '4111 1111 1111 1111');
  // 19.99 + 14.99 shipping
  await expect(page.getByText('Do zapłaty').locator('xpath=following-sibling::dd[1]')).toHaveText(/34,98\s*zł/);
  await page.getByRole('button', { name: 'Zamawiam i płacę' }).click();

  await expect(page.getByText('Zamówienie opłacone')).toBeVisible();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
  const orderId = page.url().split('/').pop() ?? '';
  const orderNumber = orderId.slice(-8).toUpperCase();
  await expect(page.getByRole('heading', { name: `Zamówienie nr ${orderNumber}` })).toBeVisible();
  await expect(page.getByText('Opłacone', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Koszyk/ })).toHaveText(/Koszyk\s*0/);
  // The shipment appears after the order.created event; the page polls every 10 s
  await expect(page.getByText('W przygotowaniu — przesyłka pojawi się po przetworzeniu zamówienia')).toBeVisible();
  await expect(page.getByText('Numer śledzenia pojawi się po nadaniu paczki')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('link', { name: 'Zamówienia' }).click();
  const firstRow = page.getByRole('row').nth(1);
  await expect(firstRow.getByRole('link')).toHaveText(orderNumber);
  await expect(firstRow).toContainText('Opłacone');
  await expect(firstRow).toContainText(/34,98\s*zł/);
});

test('checkout: card ending with 0 fails the payment and keeps the cart', async ({ page }) => {
  await resetMocks(page);
  await login(page, 'customer');
  await addToCart(page, products.regular);

  await page.goto('/checkout');
  await fillCheckout(page, /^Paczkomat/, '4111111111111110');
  await page.getByRole('button', { name: 'Zamawiam i płacę' }).click();

  await expect(page.getByText(/^Płatność odrzucona — zamówienie nr [0-9A-F]{8} ma status Płatność nieudana\. Możesz spróbować ponownie\.$/)).toBeVisible();
  await expect(page).toHaveURL(/\/checkout$/);
  await expect(page.getByLabel('Numer karty')).toHaveValue('');
  await expect(page.getByRole('link', { name: /^Koszyk/ })).toHaveText(/Koszyk\s*1/);

  await page.getByRole('link', { name: 'Zamówienia' }).click();
  await expect(page.getByRole('row').nth(1)).toContainText('Płatność nieudana');
});

test('checkout: insufficient stock message', async ({ page }) => {
  await resetMocks(page);
  await login(page, 'customer');
  await addToCart(page, products.noStock);

  await page.goto('/checkout');
  await fillCheckout(page, /^Odbiór osobisty/, '4111111111111111');
  await page.getByRole('button', { name: 'Zamawiam i płacę' }).click();

  await expect(page.getByText('Za mało sztuk w magazynie.')).toBeVisible();
  await page.getByRole('link', { name: 'Przejdź do koszyka' }).click();
  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.getByRole('list', { name: 'Pozycje koszyka' })).toContainText('Młynek do kawy');
});
