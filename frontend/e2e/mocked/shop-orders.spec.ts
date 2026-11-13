import { expect, test } from '@playwright/test';
import { failNext, login, resetMocks, SEED_IDS } from '../support/mocks';

const { orders } = SEED_IDS;

test('orders: cancel before shipment and not cancellable message', async ({ page }) => {
  await resetMocks(page);
  await login(page, 'customer');
  const cancelButton = page.getByRole('button', { name: 'Anuluj zamówienie' });

  // History: newest first, item count column
  await page.getByRole('link', { name: 'Zamówienia' }).click();
  await expect(page.getByRole('columnheader', { name: 'Liczba pozycji' })).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(5);
  await page.getByRole('link', { name: orders.paid.slice(-8).toUpperCase() }).click();
  await expect(page).toHaveURL(new RegExp(`/orders/${orders.paid}$`));
  await expect(page.getByText('Numer śledzenia pojawi się po nadaniu paczki')).toBeVisible();

  // Order changed meanwhile (409 ORDER_NOT_CANCELLABLE): message, the order is reloaded. Only the POST fails:
  // the page polls GET /orders/{id} every 10 s, and a poll between failNext and the click would use the error up.
  await failNext(page, 'orders', 409, { error: 'ORDER_NOT_CANCELLABLE', method: 'POST' });
  await cancelButton.click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Tak, anuluj' }).click();
  await expect(page.getByText('Tego zamówienia nie można już anulować.')).toBeVisible();

  // PAID with a PREPARING shipment: cancel after the confirmation
  await cancelButton.click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByText('Anulować zamówienie?')).toBeVisible();
  await dialog.getByRole('button', { name: 'Tak, anuluj' }).click();
  await expect(page.getByText('Anulowane', { exact: true })).toBeVisible();
  // Shipping cancels the shipment after order.cancelled (mock: 3 s), the page sees it at the next poll (10 s).
  await expect(page.getByText('Anulowana', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(cancelButton).toBeHidden();

  // Already shipped: no cancel button
  await page.goto(`/orders/${orders.shipped}`);
  await expect(page.getByText('PL0000000002')).toBeVisible();
  await expect(cancelButton).toBeHidden();

  // Payment failed: no shipment and no cancel button
  await page.goto(`/orders/${orders.paymentFailed}`);
  await expect(page.getByText('Brak przesyłki.')).toBeVisible();
  await expect(cancelButton).toBeHidden();
});
