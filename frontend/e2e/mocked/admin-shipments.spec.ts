import { expect, test } from '@playwright/test';
import { failNext, login, resetMocks, SEED_IDS } from '../support/mocks';

const { orders } = SEED_IDS;

test('admin: shipment status change and invalid transition', async ({ page }) => {
  await resetMocks(page);
  await login(page, 'admin');
  await page.goto('/admin/shipments');

  const rowOf = (orderId: string) => page.getByRole('row').filter({ has: page.locator(`a[href="/orders/${orderId}"]`) });
  const preparing = rowOf(orders.paid);
  await expect(preparing).toContainText('W przygotowaniu');
  await expect(preparing).toContainText('Numer śledzenia pojawi się po nadaniu paczki');
  await expect(rowOf(orders.delivered)).toContainText('Dostarczona');
  await expect(rowOf(orders.delivered).getByRole('button')).toHaveCount(0);

  // PREPARING → SHIPPED: the parcel gets a tracking number.
  await preparing.getByRole('button', { name: /^Oznacz jako wysłaną/ }).click();
  await expect(page.getByText('Zmieniono status przesyłki na „Wysłana”.')).toBeVisible();
  await expect(preparing).toContainText('Wysłana');
  await expect(preparing).toContainText(/PL\d{10}/);
  await expect(preparing.getByRole('button', { name: /^Oznacz jako w drodze/ })).toBeVisible();

  // Status filter in the address.
  await page.getByLabel('Status').selectOption({ label: 'Wysłana' });
  await expect(page).toHaveURL(/\/admin\/shipments\?status=SHIPPED$/);
  await expect(page.getByRole('row')).toHaveCount(3);

  // Invalid transition (e.g. another admin changed the status in the meantime): the mock Shipping answers
  // the next request with 409 INVALID_STATUS_TRANSITION; the page shows the message and reloads the list.
  await failNext(page, 'shipments', 409, { error: 'INVALID_STATUS_TRANSITION' });
  await preparing.getByRole('button', { name: /^Oznacz jako w drodze/ }).click();
  await expect(page.getByText('Nie można zmienić statusu przesyłki w ten sposób.')).toBeVisible();
  await expect(page.getByText('Lista została odświeżona.')).toBeVisible();
  await expect(preparing).toContainText('Wysłana');

  // The next attempt works again.
  await preparing.getByRole('button', { name: /^Oznacz jako w drodze/ }).click();
  await expect(page.getByText('Zmieniono status przesyłki na „W drodze”.')).toBeVisible();
  await expect(preparing).toBeHidden();
});
