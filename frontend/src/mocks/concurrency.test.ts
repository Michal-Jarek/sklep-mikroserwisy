// Overlapping requests must not lose changes of the mock state (stage 6b L2): a handler that reads the request body
// must not save a state loaded before another handler (or window.__mocks) changed it.
import { describe, expect, it, vi } from 'vitest';
import type { Cart } from '../api/types';
import { deferred } from '../test/auth';
import { mockControls } from './controls';
import { loadState } from './db';
import { setupMockServer } from './node';
import { SEED_IDS } from './seed';
import { call, customerToken } from './test-utils';

setupMockServer();

const { products } = SEED_IDS;

describe('mock state with overlapping requests', () => {
  it('keeps both items of two concurrent POST /cart/items', async () => {
    const token = customerToken();

    const results = await Promise.all([
      call('POST', '/cart/items', { token, body: { productId: products.regular, quantity: 1 } }),
      call('POST', '/cart/items', { token, body: { productId: products.purchased, quantity: 2 } }),
    ]);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const cart = await call<Cart>('GET', '/cart', { token });
    expect(cart.body.items.map((i) => i.productId).sort()).toEqual([products.regular, products.purchased].sort());
  });

  it('keeps a failure planned by failNext while a POST handler is reading its body', async () => {
    const token = customerToken();
    // The body of the POST arrives only after failNext has saved the state (text() or json(): whichever the mocks use).
    const bodyRead = deferred<void>();
    const { text, json } = Request.prototype;
    const textSpy = vi.spyOn(Request.prototype, 'text').mockImplementation(async function (this: Request) {
      await bodyRead.promise;
      return text.call(this);
    });
    const jsonSpy = vi.spyOn(Request.prototype, 'json').mockImplementation(async function (this: Request) {
      await bodyRead.promise;
      return json.call(this) as Promise<unknown>;
    });

    try {
      const added = call('POST', '/cart/items', { token, body: { productId: products.regular, quantity: 1 } });
      await vi.waitFor(() => expect(textSpy.mock.calls.length + jsonSpy.mock.calls.length).toBeGreaterThan(0));
      mockControls.failNext('orders', 503);
      bodyRead.resolve();
      expect((await added).status).toBe(200);
    } finally {
      textSpy.mockRestore();
      jsonSpy.mockRestore();
    }

    expect(loadState().failures.orders).toMatchObject({ status: 503, remaining: 1 });
    expect(loadState().carts[SEED_IDS.customer].map((i) => i.productId)).toEqual([products.regular]);
  });
});
