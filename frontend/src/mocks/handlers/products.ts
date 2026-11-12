// Mock Product with categories (contract: docs/frontend-api.md, section Product).
import type { ProductDetail, ProductRequest, ProductSort, ProductSummary } from '../../api/types';
import type { MockProduct, MockState } from '../db';
import { badRequest, json, noContent, notFound, now, route } from '../http';
import { MONEY_PATTERN, parseMoney, PRICE_FILTER_PATTERN, toMoney } from '../money';
import { objectWith, oneOf, pageOf, pageRequest, pathUuid, readBody, text, uuid } from '../validation';

const SORTS: readonly ProductSort[] = ['NAME', 'PRICE_ASC', 'PRICE_DESC', 'NEWEST'];
const PRODUCT_FIELDS = ['name', 'description', 'price', 'currency', 'categoryId', 'imageUrl'];

const byName = (a: MockProduct, b: MockProduct): number => a.name.localeCompare(b.name, 'pl');

const summary = (p: MockProduct): ProductSummary => ({
  id: p.id,
  name: p.name,
  price: toMoney(p.priceCents),
  currency: 'PLN',
  categoryId: p.categoryId,
  imageUrl: p.imageUrl,
});

export function productDetail(state: MockState, p: MockProduct): ProductDetail {
  const category = state.categories.find((c) => c.id === p.categoryId) ?? { id: p.categoryId, name: '' };
  const reviews = state.reviews.filter((r) => r.productId === p.id);
  const sum = reviews.reduce((total, r) => total + r.rating, 0);
  const stock = state.stock[p.id];
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    price: toMoney(p.priceCents),
    currency: 'PLN',
    category: { ...category },
    imageUrl: p.imageUrl,
    rating: p.ratingUnavailable
      ? null
      : { average: reviews.length === 0 ? null : Math.round((sum / reviews.length) * 10) / 10, count: reviews.length },
    availability: stock
      ? { available: stock.quantity - stock.reserved, inStock: stock.quantity - stock.reserved > 0 }
      : null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function priceFilter(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null) {
    return null;
  }
  const cents = parseMoney(raw, PRICE_FILTER_PATTERN);
  if (cents === null) {
    throw badRequest(`${name} must be an amount`);
  }
  return cents;
}

function productInput(state: MockState, body: Record<string, unknown>): Omit<ProductRequest, 'price'> & { priceCents: number } {
  objectWith(body, PRODUCT_FIELDS, 'body');
  const name = text(body.name, 'name', 1, 200);
  const description = text(body.description, 'description', 0, 5000);
  const priceCents = typeof body.price === 'string' ? parseMoney(body.price, MONEY_PATTERN) : null;
  if (priceCents === null || priceCents < 1) {
    throw badRequest('price must be an amount of at least 0.01');
  }
  const currency = oneOf(body.currency, 'currency', ['PLN'] as const);
  const categoryId = uuid(body.categoryId, 'categoryId');
  if (!state.categories.some((c) => c.id === categoryId)) {
    throw badRequest('Unknown category');
  }
  let imageUrl: string | null = null;
  if (body.imageUrl !== null) {
    imageUrl = text(body.imageUrl, 'imageUrl', 9, 2000);
    if (!/^https:\/\/[^\s/]+\S*$/.test(imageUrl)) {
      throw badRequest('imageUrl must be an https address');
    }
  }
  return { name, description, priceCents, currency, categoryId, imageUrl };
}

function findProduct(state: MockState, productId: string): MockProduct {
  const product = state.products.find((p) => p.id === productId);
  if (!product) {
    throw notFound('Product not found');
  }
  return product;
}

export const productHandlers = [
  route('GET', '/products', ({ url, state }) => {
    const q = url.searchParams.has('q') ? text(url.searchParams.get('q'), 'q', 0, 200).toLowerCase() : '';
    const categoryId = url.searchParams.has('categoryId') ? uuid(url.searchParams.get('categoryId'), 'categoryId') : null;
    const minPrice = priceFilter(url, 'minPrice');
    const maxPrice = priceFilter(url, 'maxPrice');
    if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
      throw badRequest('minPrice must not be greater than maxPrice');
    }
    const sort = url.searchParams.has('sort') ? oneOf(url.searchParams.get('sort'), 'sort', SORTS) : 'NAME';
    const paging = pageRequest(url);

    const found = state.products.filter(
      (p) =>
        (q === '' || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)) &&
        (categoryId === null || p.categoryId === categoryId) &&
        (minPrice === null || p.priceCents >= minPrice) &&
        (maxPrice === null || p.priceCents <= maxPrice),
    );
    const sorted = [...found].sort((a, b) => {
      switch (sort) {
        case 'PRICE_ASC':
          return a.priceCents - b.priceCents || byName(a, b);
        case 'PRICE_DESC':
          return b.priceCents - a.priceCents || byName(a, b);
        case 'NEWEST':
          return b.createdAt.localeCompare(a.createdAt) || byName(a, b);
        default:
          return byName(a, b);
      }
    });
    return json(pageOf(sorted.map(summary), paging));
  }),

  route('GET', '/products/:productId', ({ params, state }) =>
    json(productDetail(state, findProduct(state, pathUuid(params, 'productId')))),
  ),

  route('GET', '/categories', ({ state }) =>
    json([...state.categories].sort((a, b) => a.name.localeCompare(b.name, 'pl'))),
  ),

  route('POST', '/products', async ({ request, state }) => {
    const input = productInput(state, await readBody(request, PRODUCT_FIELDS));
    const timestamp = now();
    const product: MockProduct = {
      id: crypto.randomUUID(),
      name: input.name,
      description: input.description,
      priceCents: input.priceCents,
      categoryId: input.categoryId,
      imageUrl: input.imageUrl,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    state.products.push(product);
    return json(productDetail(state, product), 201);
  }),

  route('PUT', '/products/:productId', async ({ params, request, state }) => {
    const productId = pathUuid(params, 'productId');
    const input = productInput(state, await readBody(request, PRODUCT_FIELDS));
    const product = findProduct(state, productId);
    Object.assign(product, {
      name: input.name,
      description: input.description,
      priceCents: input.priceCents,
      categoryId: input.categoryId,
      imageUrl: input.imageUrl,
      updatedAt: now(),
    });
    return json(productDetail(state, product));
  }),

  route('DELETE', '/products/:productId', ({ params, state }) => {
    const product = findProduct(state, pathUuid(params, 'productId'));
    state.products = state.products.filter((p) => p.id !== product.id);
    return noContent();
  }),
];
