import { expect, test } from '@playwright/test';
import { login, resetMocks } from '../support/mocks';

test('admin: product create, edit, delete and stock update', async ({ page }) => {
  await resetMocks(page);
  await login(page, 'admin');

  await page.getByRole('navigation', { name: 'Konto' }).getByRole('link', { name: 'Panel admina' }).click();
  await expect(page).toHaveURL(/\/admin\/products$/);
  await expect(page.getByRole('heading', { name: 'Produkty', level: 1 })).toBeVisible();

  // Create: price typed with a comma, no image.
  await page.getByRole('link', { name: 'Dodaj produkt' }).click();
  await expect(page.getByRole('heading', { name: 'Nowy produkt' })).toBeVisible();
  await page.getByLabel('Nazwa').fill('Lampka biurkowa E2E');
  await page.getByLabel('Opis').fill('Lampka z testu E2E');
  await page.getByLabel('Cena (zł)').fill('49,5');
  await page.getByLabel('Kategoria').selectOption({ label: 'Elektronika' });
  await page.getByRole('button', { name: 'Dodaj produkt' }).click();

  await expect(page).toHaveURL(/\/admin\/products\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Edycja produktu' })).toBeVisible();
  await expect(page.getByLabel('Cena (zł)')).toHaveValue('49,50');
  const productUrl = page.url();

  // Stock: a new product has no record yet.
  const stock = page.getByRole('region', { name: 'Stan magazynowy' });
  await expect(stock.getByText('Brak stanu — ustaw ilość')).toBeVisible();
  await stock.getByLabel('Ilość w magazynie').fill('7');
  await stock.getByRole('button', { name: 'Zapisz stan' }).click();
  await expect(stock.getByRole('definition').first()).toHaveText('7');
  await expect(stock.getByText('Brak stanu — ustaw ilość')).toBeHidden();

  // Edit.
  await page.getByLabel('Nazwa').fill('Lampka biurkowa E2E plus');
  await page.getByRole('button', { name: 'Zapisz zmiany' }).click();
  await expect(page.getByText('Zapisano produkt.')).toBeVisible();

  // The shop shows the new name, price and availability.
  await page.goto(productUrl.replace('/admin/products/', '/products/'));
  await expect(page.getByRole('heading', { name: 'Lampka biurkowa E2E plus', level: 1 })).toBeVisible();
  await expect(page.getByText('Dostępne: 7 szt.')).toBeVisible();

  // Search in the list (kept in the address) and delete with confirmation.
  await page.goto('/admin/products');
  await page.getByLabel('Szukaj produktu').fill('Lampka biurkowa');
  await expect(page).toHaveURL(/\/admin\/products\?q=Lampka\+biurkowa$/);
  const row = page.getByRole('row').filter({ hasText: 'Lampka biurkowa E2E plus' });
  await expect(row).toContainText('49,50');
  await row.getByRole('button', { name: 'Usuń produkt Lampka biurkowa E2E plus' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('„Lampka biurkowa E2E plus” zniknie z katalogu');
  await dialog.getByRole('button', { name: 'Usuń produkt' }).click();
  await expect(page.getByText('Nie znaleziono produktów.')).toBeVisible();

  // Reload keeps the search.
  await page.reload();
  await expect(page.getByLabel('Szukaj produktu')).toHaveValue('Lampka biurkowa');
  await expect(page.getByText('Nie znaleziono produktów.')).toBeVisible();
});
