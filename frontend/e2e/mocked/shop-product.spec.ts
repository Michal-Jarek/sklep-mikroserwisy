import { expect, test } from '@playwright/test';
import { failNext, login, resetMocks, SEED_IDS } from '../support/mocks';

const { products } = SEED_IDS;

test('product: rating, availability and their fallbacks', async ({ page }) => {
  await resetMocks(page);
  const addToCart = page.getByRole('button', { name: 'Dodaj do koszyka' });

  await page.goto(`/products/${products.regular}`);
  await expect(page.getByRole('heading', { name: 'Kubek ceramiczny', level: 1 })).toBeVisible();
  await expect(page.getByText('4,1 / 5 (12 opinii)')).toBeVisible();
  await expect(page.getByText('Dostępne: 50 szt.')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Lista opinii' }).getByRole('listitem')).toHaveCount(10);
  await expect(addToCart).toBeEnabled();

  await page.goto(`/products/${products.ratingUnavailable}`);
  await expect(page.getByText('Ocena chwilowo niedostępna')).toBeVisible();

  await page.goto(`/products/${products.noReviews}`);
  await expect(page.getByText('Brak opinii')).toBeVisible();
  await expect(page.getByText('Nikt jeszcze nie ocenił tego produktu.')).toBeVisible();

  await page.goto(`/products/${products.noStock}`);
  await expect(page.getByText('Dostępność sprawdzimy przy zamówieniu')).toBeVisible();
  await expect(addToCart).toBeEnabled();

  await page.goto(`/products/${products.outOfStock}`);
  await expect(page.getByText('Brak w magazynie')).toBeVisible();
  await expect(addToCart).toBeDisabled();

  // Review unavailable (503, also after the client's retry): only the reviews section shows the message.
  // The error is planned after the page has loaded (failNext counts every request to /reviews) and
  // shows on the second page of reviews.
  await page.goto(`/products/${products.regular}`);
  const reviewsSection = page.getByRole('region', { name: 'Opinie' });
  await expect(reviewsSection.getByRole('listitem')).toHaveCount(10);
  await failNext(page, 'reviews', 503, { times: 2 });
  await reviewsSection.getByRole('button', { name: 'Następna' }).click();
  await expect(reviewsSection.getByText('Usługa jest chwilowo niedostępna. Spróbuj ponownie za chwilę.')).toBeVisible();
  await expect(page.getByText('4,1 / 5 (12 opinii)')).toBeVisible();
  await expect(addToCart).toBeEnabled();
  await reviewsSection.getByRole('button', { name: 'Spróbuj ponownie' }).click();
  await expect(reviewsSection.getByRole('listitem')).toHaveCount(2);

  // Unknown product
  await page.goto('/products/a0000000-0000-4000-8000-0000000000ff');
  await expect(page.getByText('Nie znaleziono.')).toBeVisible();
});

test('reviews: add, duplicate and not purchased', async ({ page }) => {
  await resetMocks(page);
  await login(page, 'customer');
  const form = page.getByRole('form', { name: 'Dodaj opinię' });

  // Bought product without a review: accepted
  await page.goto(`/products/${products.purchased}`);
  await expect(page.getByText('Brak opinii')).toBeVisible();
  await form.getByLabel('Ocena').selectOption('4');
  await form.getByLabel('Komentarz (opcjonalnie)').fill('Trzyma ciepło cały dzień.');
  await form.getByRole('button', { name: 'Dodaj opinię' }).click();
  const list = page.getByRole('list', { name: 'Lista opinii' });
  await expect(list.getByText('Trzyma ciepło cały dzień.')).toBeVisible();
  await expect(list.getByText('Twoja opinia')).toBeVisible();
  await expect(page.getByText('4,0 / 5 (1 opinia)')).toBeVisible();

  // Second review of the same product: 409
  await form.getByLabel('Ocena').selectOption('5');
  await form.getByRole('button', { name: 'Dodaj opinię' }).click();
  await expect(form.getByText('Ten produkt już oceniłeś.')).toBeVisible();

  // Product not bought: 403
  await page.goto(`/products/${products.noReviews}`);
  await form.getByLabel('Ocena').selectOption('5');
  await form.getByRole('button', { name: 'Dodaj opinię' }).click();
  await expect(form.getByText('Opinię może dodać tylko osoba, która kupiła ten produkt.')).toBeVisible();
});
