import { expect, test, newAccount, registerAndLogIn } from './helpers';

// Purchase path on the real services of `full-shop` (Auth, User, Product, Inventory, Cart, Review): registration,
// login, catalog, product page, cart. Precondition: the product has stock — after the UUID fix of Inventory the Cart
// refuses a product without it (409), so run `bash postman/run.sh compose` first (it sets the stock, frontend README).
// CSP violations are collected by the `cspViolations` fixture of helpers.ts.
// Logins in this file: 1.
const ALGORYTMY = 'a0000000-0000-4000-8000-000000000010';

test('shop flow: register, log in, catalog, product, add to cart, cart total', async ({ page }) => {
  await registerAndLogIn(page, newAccount());

  // Catalog: at least one product card, then the header search finds "Algorytmy".
  await page.goto('/');
  const cards = page.getByRole('list', { name: 'Produkty' }).getByRole('listitem');
  await expect(cards.first()).toBeVisible();
  await page.getByRole('searchbox', { name: 'Szukaj produktów' }).fill('Algorytmy');
  await page.getByRole('searchbox', { name: 'Szukaj produktów' }).press('Enter');
  await cards.filter({ has: page.getByRole('heading', { name: 'Algorytmy', exact: true }) }).getByRole('link').click();

  await expect(page).toHaveURL(new RegExp(`/products/${ALGORYTMY}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Algorytmy' })).toBeVisible();
  // The price as the page shows it (pl-PL, e.g. "119,00 zł"); the cart total must be the same text.
  const price = (await page.getByRole('heading', { level: 1 }).locator('xpath=../following-sibling::span[1]').innerText()).trim();
  expect(price).toMatch(/^\d[\d\s]*,\d{2}\s*zł$/);
  // The same amount in the cart; spaces of the pl-PL format (also no-break spaces) match any white space.
  const samePrice = new RegExp(`^Suma:\\s*${price.replace(/\s+/g, '\\s*')}$`);

  await page.getByRole('button', { name: 'Dodaj do koszyka' }).click();
  await expect(page.getByText('Produkt jest w koszyku.')).toBeVisible();

  await page.getByRole('link', { name: /^Koszyk/ }).click();
  await expect(page).toHaveURL(/\/cart$/);
  const items = page.getByRole('list', { name: 'Pozycje koszyka' }).getByRole('listitem');
  await expect(items).toHaveCount(1);
  await expect(items.first().getByRole('link', { name: 'Algorytmy', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Ilość: Algorytmy' })).toHaveValue('1');
  await expect(page.getByText(/^Suma:/)).toHaveText(samePrice);
});
