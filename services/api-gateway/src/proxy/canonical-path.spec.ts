import { GATEWAY_PREFIX } from '../routes';
import { canonicalPath, findService } from './canonical-path';

const url = (rest: string): string => `${GATEWAY_PREFIX}${rest}`;

describe('canonicalPath', () => {
  it.each([
    ['/products/abc-1?q=a%20b&sort=price', ['products', 'abc-1'], '/products/abc-1', 'q=a%20b&sort=price'],
    ['/%70roducts/abc-2', ['products', 'abc-2'], '/products/abc-2', ''],
    ['/categories', ['categories'], '/categories', ''],
    ['/orders/purchase%64?userId=x&productId=y', ['orders', 'purchased'], '/orders/purchased', 'userId=x&productId=y'],
    ['/%75sers', ['users'], '/users', ''],
    ['/products/a.b/~x/abc-1/%41', ['products', 'a.b', '~x', 'abc-1', 'A'], '/products/a.b/~x/abc-1/A', ''],
    ['/products/..a/a..', ['products', '..a', 'a..'], '/products/..a/a..', ''],
    ['/products/0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e', ['products', '0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e'], '/products/0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e', ''],
    // The query stays raw, also when it is not valid percent-encoding; only the first "?" splits.
    ['/products?q=%zz&x=%C4%85&y=a?b', ['products'], '/products', 'q=%zz&x=%C4%85&y=a?b'],
    ['/products?', ['products'], '/products', ''],
  ])('%s', (rest, segments, path, query) => {
    expect(canonicalPath(url(rest))).toEqual({ segments, path, query });
  });

  it('the prefix alone has no segments (no route -> 404)', () => {
    expect(canonicalPath(GATEWAY_PREFIX)).toEqual({ segments: [], path: '/', query: '' });
    expect(canonicalPath(`${GATEWAY_PREFIX}?x=1`)).toEqual({ segments: [], path: '/', query: 'x=1' });
  });

  it.each([
    // K28
    '/products/../users/me',
    '/products/%2e%2e/users/me',
    '/products/%2E%2E',
    '/products/.',
    '/products/a%2Fb',
    '/products/a%5Cb',
    '/products//a',
    '/products/',
    '/products/a;b=1',
    '/products/%zz',
    '/products/a%00b',
    '/products/a%20b',
    '/products/%C4%85',
    // K29, E3 and other cases
    '/orders/purchased;x',
    '/',
    '/./products',
    '/products/%2e',
    '/products/a\\b',
    '/products/a b',
    '/products/\u0105',
    '/products/a%',
    '/products/a%2',
    '/products/%E0%A4%A',
    '/products/a#b',
    '/products/a@b',
    '/products/a+b',
    '/products/a%3Fb',
  ])('%s -> null (400)', (rest) => {
    expect(canonicalPath(url(rest))).toBeNull();
  });

  it('rejects targets outside the prefix (e.g. the absolute form)', () => {
    expect(canonicalPath(`${GATEWAY_PREFIX}products`)).toBeNull();
    expect(canonicalPath(`http://localhost${GATEWAY_PREFIX}/products`)).toBeNull();
  });
});

describe('findService', () => {
  const routes = new Map([
    ['products', 'product-service'],
    ['categories', 'product-service'],
  ]);

  it('maps the first segment by exact, case-sensitive match', () => {
    expect(findService(routes, ['products', '12'])).toBe('product-service');
    expect(findService(routes, ['categories'])).toBe('product-service');
    expect(findService(routes, ['Products'])).toBeUndefined();
    expect(findService(routes, ['product'])).toBeUndefined();
    expect(findService(routes, ['products-x'])).toBeUndefined();
    expect(findService(routes, ['payments'])).toBeUndefined();
  });

  it('has no route without segments', () => {
    expect(findService(routes, [])).toBeUndefined();
  });
});
