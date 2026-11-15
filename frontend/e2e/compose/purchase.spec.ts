import { expect, test, newAccount, registerAndLogIn } from './helpers';

// Purchase through the UI on the real services of `full-shop` (stage 8): cart → checkout → order page PAID →
// shipment PREPARING ("W przygotowaniu") after order.created reaches Shipping. At the end the order is cancelled,
// so the test leaves no reservation behind (a repeated run starts from the same stock).
// Precondition: the product has stock — run `bash postman/run.sh compose` first (it sets the stock, frontend README).
// CSP violations are collected by the `cspViolations` fixture of helpers.ts.
// Logins in this file: 1.
const PRODUCT = 'a0000000-0000-4000-8000-000000000003';

test('purchase: checkout with a new address, order PAID, shipment in preparation, cancel', async ({ page }) => {
  await registerAndLogIn(page, newAccount());

  await page.goto(`/products/${PRODUCT}`);
  await page.getByRole('button', { name: 'Dodaj do koszyka' }).click();
  await expect(page.getByText('Produkt jest w koszyku.')).toBeVisible();

  await page.getByRole('link', { name: /^Koszyk/ }).click();
  await page.getByRole('link', { name: 'Przejdź do zamówienia' }).click();
  await expect(page).toHaveURL(/\/checkout$/);

  // A new account has no saved address: "Nowy adres", names from the profile.
  await expect(page.getByRole('heading', { name: '1. Adres dostawy' })).toBeVisible();
  await expect(page.getByLabel('Nowy adres')).toBeChecked();
  await expect(page.getByLabel('Imię')).toHaveValue('Test');
  await page.getByLabel('Ulica i numer').fill('ul. Testowa 1');
  await page.getByLabel('Miasto').fill('Warszawa');
  await page.getByLabel('Kod pocztowy').fill('00-001');
  await page.getByLabel('Kraj (kod z 2 liter)').fill('PL');
  await page.getByLabel(/^Kurier/).check();
  await page.getByLabel('Numer karty').fill('4111 1111 1111 1111');
  await page.getByRole('button', { name: 'Zamawiam i płacę' }).click();

  await expect(page.getByText('Zamówienie opłacone')).toBeVisible();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
  const orderNumber = (page.url().split('/').pop() ?? '').slice(-8).toUpperCase();
  await expect(page.getByRole('heading', { name: `Zamówienie nr ${orderNumber}` })).toBeVisible();
  await expect(page.getByText('Opłacone', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Koszyk/ })).toHaveText(/Koszyk\s*0/);

  // Shipping creates the shipment after order.created; the page polls every 10 s.
  const shipmentStatus = page.getByText('Status przesyłki').locator('xpath=following-sibling::dd[1]');
  await expect(shipmentStatus).toHaveText('W przygotowaniu', { timeout: 15_000 });
  await expect(page.getByText('Numer śledzenia pojawi się po nadaniu paczki')).toBeVisible();

  // Cleanup through the UI: cancel before shipping releases the reservation.
  await page.getByRole('button', { name: 'Anuluj zamówienie' }).click();
  await page.getByRole('button', { name: 'Tak, anuluj' }).click();
  await expect(page.getByText('Anulowane', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Anuluj zamówienie' })).toBeHidden();
});
