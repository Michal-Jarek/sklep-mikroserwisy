// Catalog filters live in the address (q, categoryId, minPrice, maxPrice, sort, page), so reloading
// and sharing a link keep them. Values from the address are checked before they reach the API.
import type { ProductListQuery, ProductSort } from '@/api/types';

export const CATALOG_PAGE_SIZE = 12;

export type CatalogParam = 'q' | 'categoryId' | 'minPrice' | 'maxPrice' | 'sort' | 'page';

export const PRODUCT_SORTS: readonly ProductSort[] = ['NAME', 'PRICE_ASC', 'PRICE_DESC', 'NEWEST'];

const PRICE = /^\d{1,8}(\.\d{1,2})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QUERY_LENGTH = 200;

function valid(value: string | null, pattern: RegExp): string | undefined {
  return value !== null && pattern.test(value) ? value : undefined;
}

/** Query of GET /products from the address; invalid values are left out (the API would answer 400). */
export function readCatalogQuery(params: URLSearchParams): ProductListQuery & { page: number } {
  const q = (params.get('q') ?? '').trim().slice(0, MAX_QUERY_LENGTH);
  const sort = params.get('sort');
  const page = Number(params.get('page'));
  return {
    q: q || undefined,
    categoryId: valid(params.get('categoryId'), UUID),
    minPrice: valid(params.get('minPrice'), PRICE),
    maxPrice: valid(params.get('maxPrice'), PRICE),
    sort: PRODUCT_SORTS.find((s) => s === sort),
    page: Number.isInteger(page) && page > 1 ? page : 1,
    size: CATALOG_PAGE_SIZE,
  };
}

/**
 * Address parameters after a change: an empty value removes the parameter; changing a filter
 * (anything but `page`) goes back to the first page.
 */
export function withCatalogChanges(params: URLSearchParams, changes: Partial<Record<CatalogParam, string | undefined>>): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(changes)) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  if (!('page' in changes) || changes.page === '1') next.delete('page');
  return next;
}
