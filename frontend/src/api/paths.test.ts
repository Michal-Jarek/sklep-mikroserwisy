// Z17 (a): every path parameter is one encoded segment and "." or ".." is rejected (the URL parser drops
// dot segments, also encoded ones), so a value from the address bar or the API cannot change the target path.
import { describe, expect, it } from 'vitest';
import { paths } from '@/api/paths';

const builders: [string, (value: string) => string, (encoded: string) => string][] = [
  ['users.address', paths.users.address, (e) => `/users/me/addresses/${e}`],
  ['cart.item', paths.cart.item, (e) => `/cart/items/${e}`],
  ['products.detail', paths.products.detail, (e) => `/products/${e}`],
  ['inventory', paths.inventory, (e) => `/inventory/${e}`],
  ['reviews.detail', paths.reviews.detail, (e) => `/reviews/${e}`],
  ['orders.detail', paths.orders.detail, (e) => `/orders/${e}`],
  ['orders.cancel', paths.orders.cancel, (e) => `/orders/${e}/cancel`],
  ['shipments.status', paths.shipments.status, (e) => `/shipments/${e}/status`],
];

const values: [string, string][] = [
  ['../a/b', '..%2Fa%2Fb'],
  ['...', '...'],
  ['a?admin=1', 'a%3Fadmin%3D1'],
  ['a#x', 'a%23x'],
  ['100%', '100%25'],
  ['a b', 'a%20b'],
];

describe('paths: parameters are encoded as one segment', () => {
  it('products.detail("../a/b") → /products/..%2Fa%2Fb', () => {
    expect(paths.products.detail('../a/b')).toBe('/products/..%2Fa%2Fb');
  });

  describe.each(builders)('%s', (_name, build, expected) => {
    it.each(values)('%j → %s', (value, encoded) => {
      expect(build(value)).toBe(expected(encoded));
    });

    it.each(['.', '..'])('%j is rejected (a dot segment would be dropped by the URL parser)', (value) => {
      expect(() => build(value)).toThrow('Invalid path parameter');
    });
  });
});
