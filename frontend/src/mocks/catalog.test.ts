import { describe, expect, it } from 'vitest';
import type { Category, Page, ProductDetail, ProductSummary, Review, StockLevel } from '../api/types';
import { setupMockServer } from './node';
import { SEED_IDS } from './seed';
import { adminToken, call, customerToken } from './test-utils';

setupMockServer();

const products = (query: string) => call<Page<ProductSummary>>('GET', `/products${query}`);

describe('products: list', () => {
  it('pages the catalog with defaults 1 and 20', async () => {
    const first = await products('');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ page: 1, size: 20, total: 24 });
    expect(first.body.items).toHaveLength(20);
    const third = await products('?page=3&size=10');
    expect(third.body.items).toHaveLength(4);
    const beyond = await products('?page=9&size=10');
    expect(beyond.body.items).toEqual([]);
  });

  it.each(['?page=0', '?size=101', '?page=x', '?sort=CHEAP', '?minPrice=1,5', '?categoryId=1', '?minPrice=50&maxPrice=10'])(
    'answers 400 VALIDATION_ERROR for %s',
    async (query) => {
      const result = await call<{ error: string }>('GET', `/products${query}`);
      expect(result.status).toBe(400);
      expect(result.body.error).toBe('VALIDATION_ERROR');
    },
  );

  it('filters by text, category and price, and sorts', async () => {
    expect((await products('?q=KUBEK')).body.items.map((p) => p.name)).toEqual(['Kubek ceramiczny']);
    expect((await products('?q=zmywarce')).body.total).toBe(1);
    const books = await products(`?categoryId=${SEED_IDS.categories.books}`);
    expect(books.body.total).toBe(6);
    const range = await products('?minPrice=10&maxPrice=20.5&sort=PRICE_ASC');
    expect(range.body.items.map((p) => p.price)).toEqual(['19.90', '19.99']);
    const desc = await products('?sort=PRICE_DESC&size=1');
    expect(desc.body.items[0].price).toBe('299.00');
    const newest = await products('?sort=NEWEST&size=1');
    expect(newest.body.items[0].name).toBe('Nasiona ziół');
    const byName = await products('?size=2');
    expect(byName.body.items.map((p) => p.name)).toEqual(['Algorytmy', 'Bazy danych']);
  });

  it('returns amounts as text with currency', async () => {
    const item = (await products('?q=kubek')).body.items[0];
    expect(item).toMatchObject({ price: '19.99', currency: 'PLN', categoryId: SEED_IDS.categories.kitchen });
  });
});

describe('products: detail and categories', () => {
  const detail = async (id: string) => (await call<ProductDetail>('GET', `/products/${id}`)).body;

  it('has rating and availability of a regular product', async () => {
    const p = await detail(SEED_IDS.products.regular);
    expect(p.rating).toEqual({ average: 4.1, count: 12 });
    expect(p.availability).toEqual({ available: 50, inStock: true });
    expect(p.category).toEqual({ id: SEED_IDS.categories.kitchen, name: 'Kuchnia' });
  });

  it('has the fallback cases of the seed data', async () => {
    expect((await detail(SEED_IDS.products.ratingUnavailable)).rating).toBeNull();
    expect((await detail(SEED_IDS.products.noReviews)).rating).toEqual({ average: null, count: 0 });
    expect((await detail(SEED_IDS.products.noStock)).availability).toBeNull();
    expect((await detail(SEED_IDS.products.outOfStock)).availability).toEqual({ available: 0, inStock: false });
  });

  it('answers 404 for an unknown product', async () => {
    const result = await call<{ error: string }>('GET', '/products/00000000-0000-4000-8000-000000000000');
    expect(result.status).toBe(404);
    expect(result.body.error).toBe('NOT_FOUND');
  });

  it('lists categories alphabetically', async () => {
    const result = await call<Category[]>('GET', '/categories');
    expect(result.body.map((c) => c.name)).toEqual(['Elektronika', 'Książki', 'Kuchnia', 'Ogród']);
  });
});

describe('products: admin', () => {
  const input = {
    name: 'Nowy produkt',
    description: '',
    price: '12.50',
    currency: 'PLN',
    categoryId: SEED_IDS.categories.garden,
    imageUrl: null,
  };

  it('creates, updates and deletes a product', async () => {
    const created = await call<ProductDetail>('POST', '/products', { token: adminToken(), body: input });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Nowy produkt', price: '12.50', rating: { average: null, count: 0 }, availability: null });

    const updated = await call<ProductDetail>('PUT', `/products/${created.body.id}`, {
      token: adminToken(),
      body: { ...input, price: '13.00', imageUrl: 'https://img.example.com/a.jpg' },
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ price: '13.00', imageUrl: 'https://img.example.com/a.jpg' });

    expect((await call('DELETE', `/products/${created.body.id}`, { token: adminToken() })).status).toBe(204);
    expect((await call('GET', `/products/${created.body.id}`)).status).toBe(404);
  });

  it.each([
    ['unknown category', { categoryId: '00000000-0000-4000-8000-000000000000' }],
    ['price as number', { price: 12.5 }],
    ['zero price', { price: '0.00' }],
    ['http image', { imageUrl: 'http://img.example.com/a.jpg' }],
    ['empty name', { name: ' ' }],
    ['unknown field', { stock: 3 }],
  ])('answers 400 for %s', async (_case, change) => {
    const result = await call('POST', '/products', { token: adminToken(), body: { ...input, ...change } });
    expect(result.status).toBe(400);
  });

  it('answers 403 for a customer', async () => {
    expect((await call('POST', '/products', { token: customerToken(), body: input })).status).toBe(403);
  });
});

describe('inventory', () => {
  it('reads stock and answers 404 without a record', async () => {
    const stock = await call<StockLevel>('GET', `/inventory/${SEED_IDS.products.regular}`);
    expect(stock.body).toEqual({ productId: SEED_IDS.products.regular, quantity: 50, reserved: 0, available: 50, inStock: true });
    expect((await call('GET', `/inventory/${SEED_IDS.products.noStock}`)).status).toBe(404);
  });

  it('creates a stock record and rejects a quantity below reserved', async () => {
    const created = await call<StockLevel>('PUT', `/inventory/${SEED_IDS.products.noStock}`, { token: adminToken(), body: { quantity: 3 } });
    expect(created.body).toMatchObject({ quantity: 3, available: 3, inStock: true });
    const detail = await call<ProductDetail>('GET', `/products/${SEED_IDS.products.noStock}`);
    expect(detail.body.availability).toEqual({ available: 3, inStock: true });

    // "Czysty kod" has 1 piece reserved by the paid order of the customer.
    const paidProduct = 'a0000000-0000-4000-8000-000000000009';
    const conflict = await call<{ error: string }>('PUT', `/inventory/${paidProduct}`, { token: adminToken(), body: { quantity: 0 } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('CONFLICT');
    expect((await call('PUT', `/inventory/${paidProduct}`, { token: adminToken(), body: { quantity: 1_000_001 } })).status).toBe(400);
  });
});

describe('reviews: list', () => {
  it('requires productId and returns newest first', async () => {
    expect((await call('GET', '/reviews')).status).toBe(400);
    const page = await call<Page<Review>>('GET', `/reviews?productId=${SEED_IDS.products.regular}&size=10`);
    expect(page.body).toMatchObject({ page: 1, size: 10, total: 12 });
    const dates = page.body.items.map((r) => r.createdAt);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(page.body.items[0].userId).toBe(SEED_IDS.customer);
  });
});
