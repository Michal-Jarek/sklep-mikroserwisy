import { describe, expect, it } from 'vitest';
import { CATALOG_PAGE_SIZE, readCatalogQuery, withCatalogChanges } from '@/features/catalog/catalog-params';

const CATEGORY = 'c0000000-0000-4000-8000-000000000001';

describe('readCatalogQuery', () => {
  it('reads all filters from the address', () => {
    const query = readCatalogQuery(
      new URLSearchParams(`q=%20kubek%20&categoryId=${CATEGORY}&minPrice=10&maxPrice=99.99&sort=PRICE_DESC&page=3`),
    );
    expect(query).toEqual({ q: 'kubek', categoryId: CATEGORY, minPrice: '10', maxPrice: '99.99', sort: 'PRICE_DESC', page: 3, size: CATALOG_PAGE_SIZE });
  });

  it('leaves out invalid values and starts at page 1', () => {
    const query = readCatalogQuery(new URLSearchParams('q=%20&categoryId=abc&minPrice=1,5&maxPrice=-1&sort=CHEAP&page=0'));
    expect(query).toEqual({ q: undefined, categoryId: undefined, minPrice: undefined, maxPrice: undefined, sort: undefined, page: 1, size: CATALOG_PAGE_SIZE });
    expect(readCatalogQuery(new URLSearchParams('page=2.5')).page).toBe(1);
  });

  it('cuts the search text to 200 characters', () => {
    expect(readCatalogQuery(new URLSearchParams(`q=${'a'.repeat(250)}`)).q).toHaveLength(200);
  });
});

describe('withCatalogChanges', () => {
  it('a filter change removes the page and empty values', () => {
    const next = withCatalogChanges(new URLSearchParams('q=kubek&sort=NEWEST&page=4'), { sort: 'PRICE_ASC', q: '' });
    expect(next.toString()).toBe('sort=PRICE_ASC');
  });

  it('a page change keeps the filters; page 1 is not written', () => {
    expect(withCatalogChanges(new URLSearchParams('q=kubek'), { page: '2' }).toString()).toBe('q=kubek&page=2');
    expect(withCatalogChanges(new URLSearchParams('q=kubek&page=2'), { page: '1' }).toString()).toBe('q=kubek');
  });
});
