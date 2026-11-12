import { describe, expect, it, vi } from 'vitest';
import type { Cart, CartMutationResponse, OrderDetail, OrderSummary, Page, Review, Shipment, StockLevel } from '../api/types';
import { mockConfig } from './db';
import { setupMockServer } from './node';
import { SEED_IDS } from './seed';
import { adminToken, call, customerToken } from './test-utils';

setupMockServer();

const P = SEED_IDS.products;

const address = {
  firstName: 'Jan',
  lastName: 'Kowalski',
  street: 'ul. Testowa 1',
  postalCode: '00-001',
  city: 'Warszawa',
  countryCode: 'PL',
};

const addToCart = (productId: string, quantity: number, token = customerToken()) =>
  call<CartMutationResponse & { error: string }>('POST', '/cart/items', { token, body: { productId, quantity } });

const placeOrder = (cardNumber: string, shippingMethod = 'COURIER') =>
  call<OrderDetail & { error: string }>('POST', '/orders', {
    token: customerToken(),
    body: { shippingMethod, shippingAddress: address, payment: { cardNumber } },
  });

describe('cart', () => {
  it('starts empty, adds to the quantity, changes and removes items', async () => {
    const empty = await call<Cart>('GET', '/cart', { token: customerToken() });
    expect(empty.body).toEqual({ userId: SEED_IDS.customer, currency: 'PLN', items: [], total: '0.00' });

    await addToCart(P.regular, 1);
    const added = await addToCart(P.regular, 1);
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ total: '39.98', inventoryChecked: true });
    expect(added.body.items[0]).toEqual({ productId: P.regular, name: 'Kubek ceramiczny', unitPrice: '19.99', quantity: 2, subtotal: '39.98' });

    const changed = await call<CartMutationResponse>('PATCH', `/cart/items/${P.regular}`, { token: customerToken(), body: { quantity: 5 } });
    expect(changed.body.items[0].quantity).toBe(5);
    expect(changed.body.total).toBe('99.95');

    expect((await call('DELETE', `/cart/items/${P.regular}`, { token: customerToken() })).status).toBe(204);
    expect((await call('DELETE', `/cart/items/${P.regular}`, { token: customerToken() })).status).toBe(204);
    expect((await call<Cart>('GET', '/cart', { token: customerToken() })).body.items).toEqual([]);
  });

  it('answers inventoryChecked:false for a product without stock record', async () => {
    const result = await addToCart(P.noStock, 3);
    expect(result.status).toBe(200);
    expect(result.body.inventoryChecked).toBe(false);
  });

  it('answers 409 CONFLICT when there are not enough pieces or more than 999', async () => {
    const tooMany = await addToCart(P.lowStock, 3);
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error).toBe('CONFLICT');
    expect((await addToCart(P.outOfStock, 1)).status).toBe(409);
    await addToCart(P.noStock, 999);
    expect((await addToCart(P.noStock, 1)).status).toBe(409);
  });

  it('answers 400 and 404 for bad input', async () => {
    expect((await addToCart(P.regular, 0)).status).toBe(400);
    expect((await addToCart(P.regular, 1.5)).status).toBe(400);
    expect((await addToCart('123', 1)).status).toBe(400);
    expect((await addToCart('00000000-0000-4000-8000-000000000000', 1)).status).toBe(404);
    const notInCart = await call('PATCH', `/cart/items/${P.lowStock}`, { token: customerToken(), body: { quantity: 1 } });
    expect(notInCart.status).toBe(404);
  });

  it('keeps carts per user', async () => {
    await addToCart(P.regular, 1, adminToken());
    expect((await call<Cart>('GET', '/cart', { token: customerToken() })).body.items).toEqual([]);
  });
});

describe('orders', () => {
  it('pays an order: 201 PAID, sums in grosze, cart emptied, stock reserved, shipment PREPARING', async () => {
    await addToCart(P.regular, 2);
    const order = await placeOrder('4111111111111111');
    expect(order.status).toBe(201);
    expect(order.body).toMatchObject({ status: 'PAID', itemsTotal: '39.98', shippingCost: '14.99', total: '54.97', currency: 'PLN' });
    expect((await call<Cart>('GET', '/cart', { token: customerToken() })).body.items).toEqual([]);
    expect((await call<StockLevel>('GET', `/inventory/${P.regular}`)).body).toMatchObject({ reserved: 2, available: 48 });

    const shipments = await call<Page<Shipment>>('GET', `/shipments?orderId=${order.body.id}`, { token: customerToken() });
    expect(shipments.body.items).toHaveLength(1);
    expect(shipments.body.items[0]).toMatchObject({ status: 'PREPARING', trackingNumber: null, method: 'COURIER' });

    const list = await call<Page<OrderSummary>>('GET', '/orders', { token: customerToken() });
    expect(list.body.total).toBe(5);
    expect(list.body.items[0]).toMatchObject({ id: order.body.id, status: 'PAID', total: '54.97', itemCount: 1 });
  });

  it('fails the payment for a card ending with 0 and keeps the cart', async () => {
    await addToCart(P.regular, 1);
    const order = await placeOrder('4111 1111 1111 1110'.replace(/ /g, ''));
    expect(order.status).toBe(201);
    expect(order.body.status).toBe('PAYMENT_FAILED');
    expect((await call<Cart>('GET', '/cart', { token: customerToken() })).body.items).toHaveLength(1);
    expect((await call<StockLevel>('GET', `/inventory/${P.regular}`)).body.reserved).toBe(0);
    const shipments = await call<Page<Shipment>>('GET', `/shipments?orderId=${order.body.id}`, { token: customerToken() });
    expect(shipments.body.items).toEqual([]);
  });

  it('answers 409 CART_EMPTY and 409 INSUFFICIENT_STOCK', async () => {
    const empty = await placeOrder('4111111111111111');
    expect(empty.status).toBe(409);
    expect(empty.body.error).toBe('CART_EMPTY');

    await addToCart(P.noStock, 1);
    const noStock = await placeOrder('4111111111111111');
    expect(noStock.status).toBe(409);
    expect(noStock.body.error).toBe('INSUFFICIENT_STOCK');
  });

  it('validates the order body', async () => {
    await addToCart(P.regular, 1);
    expect((await placeOrder('4111111111111111', 'DRONE')).status).toBe(400);
    expect((await placeOrder('41111')).status).toBe(400);
    expect((await placeOrder('4111 1111 1111 1111')).status).toBe(400);
    const badCountry = await call('POST', '/orders', {
      token: customerToken(),
      body: { shippingMethod: 'PICKUP', shippingAddress: { ...address, countryCode: 'pl' }, payment: { cardNumber: '4111111111111111' } },
    });
    expect(badCountry.status).toBe(400);
  });

  it('shows own orders only; ADMIN can read any order', async () => {
    const own = await call<OrderDetail>('GET', `/orders/${SEED_IDS.orders.paid}`, { token: customerToken() });
    expect(own.body).toMatchObject({ status: 'PAID', total: '69.90' });
    expect((await call('GET', `/orders/${SEED_IDS.orders.paid}`, { token: adminToken() })).status).toBe(200);
    expect((await call<Page<OrderSummary>>('GET', '/orders', { token: adminToken() })).body.total).toBe(0);

    const stranger = await call('POST', '/auth/register', {
      body: { email: 'obcy@sklep.test', password: 'Obcy-atrapa-1', firstName: 'Obcy', lastName: 'Klient' },
    });
    expect(stranger.status).toBe(201);
    const login = await call<{ accessToken: string }>('POST', '/auth/login', { body: { email: 'obcy@sklep.test', password: 'Obcy-atrapa-1' } });
    expect((await call('GET', `/orders/${SEED_IDS.orders.paid}`, { token: login.body.accessToken })).status).toBe(404);
  });

  it('lists orders newest first with paging', async () => {
    const page = await call<Page<OrderSummary>>('GET', '/orders?size=2', { token: customerToken() });
    expect(page.body).toMatchObject({ page: 1, size: 2, total: 4 });
    expect(page.body.items.map((o) => o.id)).toEqual([SEED_IDS.orders.paid, SEED_IDS.orders.shipped]);
    expect((await call('GET', '/orders?size=0', { token: customerToken() })).status).toBe(400);
  });

  it('cancels a paid order before shipment and releases the reservation', async () => {
    const cancelled = await call<OrderDetail>('POST', `/orders/${SEED_IDS.orders.paid}/cancel`, { token: customerToken() });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect((await call<StockLevel>('GET', '/inventory/a0000000-0000-4000-8000-000000000009')).body.reserved).toBe(0);
    const shipments = await call<Page<Shipment>>('GET', `/shipments?orderId=${SEED_IDS.orders.paid}`, { token: customerToken() });
    expect(shipments.body.items[0].status).toBe('CANCELLED');
  });

  it('with a Shipping delay the shipment of a cancelled order stays PREPARING, then becomes CANCELLED (order.cancelled)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    mockConfig.shipmentDelayMs = 3000;
    try {
      const shipmentOf = async () =>
        (await call<Page<Shipment>>('GET', `/shipments?orderId=${SEED_IDS.orders.paid}`, { token: customerToken() })).body.items[0];
      const cancelled = await call<OrderDetail>('POST', `/orders/${SEED_IDS.orders.paid}/cancel`, { token: customerToken() });
      expect(cancelled.body.status).toBe('CANCELLED');
      const cancelAt = new Date(Date.now() + 3000).toISOString();

      vi.setSystemTime(Date.now() + 2999);
      expect((await shipmentOf()).status).toBe('PREPARING');

      vi.setSystemTime(Date.now() + 1);
      const shipment = await shipmentOf();
      expect(shipment.status).toBe('CANCELLED');
      expect(shipment.history.at(-1)).toEqual({ status: 'CANCELLED', at: cancelAt });
      expect(shipment.updatedAt).toBe(cancelAt);
      expect((await call<{ error: string }>('PATCH', `/shipments/${shipment.id}/status`, { token: adminToken(), body: { status: 'SHIPPED' } })).status).toBe(409);
    } finally {
      mockConfig.shipmentDelayMs = 0;
      vi.useRealTimers();
    }
  });

  it.each([
    ['shipped', SEED_IDS.orders.shipped],
    ['delivered', SEED_IDS.orders.delivered],
    ['payment failed', SEED_IDS.orders.paymentFailed],
  ])('answers 409 ORDER_NOT_CANCELLABLE for a %s order', async (_case, orderId) => {
    const result = await call<{ error: string }>('POST', `/orders/${orderId}/cancel`, { token: customerToken() });
    expect(result.status).toBe(409);
    expect(result.body.error).toBe('ORDER_NOT_CANCELLABLE');
  });
});

describe('shipments', () => {
  const patch = (shipmentId: string, status: string, token = adminToken()) =>
    call<Shipment & { error: string }>('PATCH', `/shipments/${shipmentId}/status`, { token, body: { status } });

  it('moves a shipment one step at a time and updates the order and stock', async () => {
    const shipped = await patch(SEED_IDS.shipments.preparing, 'SHIPPED');
    expect(shipped.status).toBe(200);
    expect(shipped.body.status).toBe('SHIPPED');
    expect(shipped.body.trackingNumber).toMatch(/^PL\d{10}$/);
    expect(shipped.body.history.map((h) => h.status)).toEqual(['PREPARING', 'SHIPPED']);
    expect((await call<OrderDetail>('GET', `/orders/${SEED_IDS.orders.paid}`, { token: customerToken() })).body.status).toBe('SHIPPED');
    expect((await call<StockLevel>('GET', '/inventory/a0000000-0000-4000-8000-000000000009')).body).toMatchObject({ quantity: 9, reserved: 0 });

    expect((await patch(SEED_IDS.shipments.preparing, 'IN_TRANSIT')).status).toBe(200);
    expect((await call<OrderDetail>('GET', `/orders/${SEED_IDS.orders.paid}`, { token: customerToken() })).body.status).toBe('SHIPPED');
    expect((await patch(SEED_IDS.shipments.preparing, 'DELIVERED')).status).toBe(200);
    expect((await call<OrderDetail>('GET', `/orders/${SEED_IDS.orders.paid}`, { token: customerToken() })).body.status).toBe('DELIVERED');
  });

  it.each([
    ['skip', SEED_IDS.shipments.preparing, 'IN_TRANSIT'],
    ['back', SEED_IDS.shipments.shipped, 'PREPARING'],
    ['from DELIVERED', SEED_IDS.shipments.delivered, 'SHIPPED'],
    ['to CANCELLED', SEED_IDS.shipments.preparing, 'CANCELLED'],
  ])('answers 409 INVALID_STATUS_TRANSITION for a %s', async (_case, shipmentId, status) => {
    const result = await patch(shipmentId, status);
    expect(result.status).toBe(409);
    expect(result.body.error).toBe('INVALID_STATUS_TRANSITION');
  });

  it('answers 400 for an unknown status, 404 for an unknown shipment, 403 for a customer', async () => {
    expect((await patch(SEED_IDS.shipments.preparing, 'LOST')).status).toBe(400);
    expect((await patch('00000000-0000-4000-8000-000000000000', 'SHIPPED')).status).toBe(404);
    expect((await patch(SEED_IDS.shipments.preparing, 'SHIPPED', customerToken())).status).toBe(403);
  });

  it('shows a customer only own shipments and ADMIN all, filtered by status', async () => {
    const own = await call<Page<Shipment>>('GET', '/shipments', { token: customerToken() });
    expect(own.body.total).toBe(3);
    const preparing = await call<Page<Shipment>>('GET', '/shipments?status=PREPARING', { token: adminToken() });
    expect(preparing.body.items.map((s) => s.id)).toEqual([SEED_IDS.shipments.preparing]);
    expect((await call('GET', '/shipments?status=LOST', { token: adminToken() })).status).toBe(400);
  });

  it('lists the shipping methods publicly', async () => {
    const methods = await call<{ code: string; price: string }[]>('GET', '/shipping/methods');
    expect(methods.body.map((m) => m.code)).toEqual(['COURIER', 'PARCEL_LOCKER', 'PICKUP']);
    expect(methods.body[2].price).toBe('0.00');
  });
});

describe('reviews: add and delete', () => {
  const post = (productId: string, token = customerToken()) =>
    call<Review & { error: string }>('POST', '/reviews', { token, body: { productId, rating: 5, comment: '  ' } });

  it('accepts a review of a bought product once', async () => {
    const created = await post(P.purchased);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ productId: P.purchased, userId: SEED_IDS.customer, rating: 5, comment: null });
    const again = await post(P.purchased);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('CONFLICT');
  });

  it('answers 403 FORBIDDEN for a product that was not bought and 409 for an already reviewed one', async () => {
    const notBought = await post(P.noReviews);
    expect(notBought.status).toBe(403);
    expect(notBought.body.error).toBe('FORBIDDEN');
    expect((await post(P.regular)).status).toBe(409);
  });

  it('validates rating and comment', async () => {
    const bad = (body: object) => call('POST', '/reviews', { token: customerToken(), body: { productId: P.purchased, ...body } });
    expect((await bad({ rating: 6, comment: null })).status).toBe(400);
    expect((await bad({ rating: 5, comment: 'x'.repeat(2001) })).status).toBe(400);
  });

  it('lets the author or ADMIN delete a review, others get 403', async () => {
    const page = await call<Page<Review>>('GET', `/reviews?productId=${P.regular}&size=20`);
    const own = page.body.items.find((r) => r.userId === SEED_IDS.customer);
    const other = page.body.items.find((r) => r.userId !== SEED_IDS.customer);
    expect((await call('DELETE', `/reviews/${other?.id}`, { token: customerToken() })).status).toBe(403);
    expect((await call('DELETE', `/reviews/${own?.id}`, { token: customerToken() })).status).toBe(204);
    expect((await call('DELETE', `/reviews/${other?.id}`, { token: adminToken() })).status).toBe(204);
    expect((await call('DELETE', `/reviews/${other?.id}`, { token: adminToken() })).status).toBe(404);
  });
});
