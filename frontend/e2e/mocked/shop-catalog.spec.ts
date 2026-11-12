import { expect, test, type Page } from '@playwright/test';
import { resetMocks, SEED_IDS } from '../support/mocks';

function param(page: Page, name: string): string | null {
  return new URL(page.url()).searchParams.get(name);
}

function productNames(page: Page) {
  return page.getByRole('list', { name: 'Produkty' }).getByRole('heading');
}

test('catalog: search, filter, sort and paging are kept in the URL', async ({ page }) => {
  await resetMocks(page);
  await page.goto('/');
  await expect(productNames(page)).toHaveCount(12);

  // Paging
  await page.getByRole('button', { name: 'Następna' }).click();
  await expect.poll(() => param(page, 'page')).toBe('2');
  await expect(page.getByText('Strona 2 z 2')).toBeVisible();

  // Sort and category: a filter change goes back to page 1
  await page.getByLabel('Sortowanie').selectOption('PRICE_DESC');
  await expect.poll(() => param(page, 'sort')).toBe('PRICE_DESC');
  expect(param(page, 'page')).toBeNull();
  await expect(productNames(page).first()).toHaveText('Klawiatura mechaniczna');

  await page.getByLabel('Kategoria').selectOption({ label: 'Elektronika' });
  await expect.poll(() => param(page, 'categoryId')).toBe(SEED_IDS.categories.electronics);
  await expect(productNames(page)).toHaveCount(6);

  // Price range (comma accepted)
  await page.getByLabel('Cena od (zł)').fill('50');
  await page.getByLabel('Cena do (zł)').fill('249,99');
  await page.getByRole('button', { name: 'Filtruj' }).click();
  await expect.poll(() => [param(page, 'minPrice'), param(page, 'maxPrice')]).toEqual(['50.00', '249.99']);
  await expect(productNames(page)).toHaveText(['Słuchawki bezprzewodowe', 'Powerbank 10000 mAh', 'Mysz komputerowa']);

  // Search after a pause in typing
  await page.getByLabel('Szukaj w nazwie i opisie').fill('mysz');
  await expect.poll(() => param(page, 'q')).toBe('mysz');
  await expect(productNames(page)).toHaveText(['Mysz komputerowa']);

  // Reload and a copied link keep everything
  const url = page.url();
  await page.reload();
  await expect(productNames(page)).toHaveText(['Mysz komputerowa']);
  await expect(page.getByLabel('Szukaj w nazwie i opisie')).toHaveValue('mysz');
  await expect(page.getByLabel('Kategoria')).toHaveValue(SEED_IDS.categories.electronics);
  await expect(page.getByLabel('Sortowanie')).toHaveValue('PRICE_DESC');
  await expect(page.getByLabel('Cena od (zł)')).toHaveValue('50.00');
  expect(page.url()).toBe(url);

  // "Wyczyść filtry", then the header search sets ?q=
  await page.getByRole('link', { name: 'Wyczyść filtry' }).click();
  await expect(productNames(page)).toHaveCount(12);
  expect(new URL(page.url()).search).toBe('');
  await page.getByRole('searchbox', { name: 'Szukaj produktów' }).fill('kubek');
  await page.getByRole('searchbox', { name: 'Szukaj produktów' }).press('Enter');
  await expect.poll(() => param(page, 'q')).toBe('kubek');
  await expect(productNames(page)).toHaveText(['Kubek ceramiczny']);
  await expect(page.getByLabel('Szukaj w nazwie i opisie')).toHaveValue('kubek');
});
