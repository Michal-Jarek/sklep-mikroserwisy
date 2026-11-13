// Mock Order (contract: docs/frontend-api.md, section Order). Placing an order does in one step what Order,
// Inventory, Shipping and the events do together: reserve stock, pay (card ending with 0 fails), clear the cart,
// create the shipment PREPARING (hidden for mockConfig.shipmentDelayMs, like after the order.created event).
// Cancelling changes the shipment to CANCELLED after the same delay (like after the order.cancelled event).
import type { OrderDetail, OrderSummary, ShippingMethodCode } from '../../api/types';
import { mockConfig, type MockState } from '../db';
import { isAdmin, json, MockApiError, notFound, now, requireIdentity, route, type Identity } from '../http';
import { MONEY_PATTERN, parseMoney, toMoney } from '../money';
import { newestFirst, objectWith, oneOf, pageOf, pageRequest, pathUuid, readBody, text } from '../validation';
import { applyPlannedCancel } from './shipping';

const ADDRESS_FIELDS = ['firstName', 'lastName', 'street', 'postalCode', 'city', 'countryCode'];

function ownOrder(state: MockState, identity: Identity, orderId: string): OrderDetail {
  const order = state.orders.find((o) => o.id === orderId);
  if (!order || (order.userId !== identity.userId && !isAdmin(identity))) {
    throw notFound('Order not found');
  }
  return order;
}

const summary = (o: OrderDetail): OrderSummary => ({
  id: o.id,
  status: o.status,
  total: o.total,
  currency: o.currency,
  itemCount: o.items.length,
  createdAt: o.createdAt,
});

export const orderHandlers = [
  route('POST', '/orders', async (ctx) => {
    const body = await readBody(ctx.request, ['shippingMethod', 'shippingAddress', 'payment']);
    const { state } = ctx;
    const shippingMethod = oneOf(body.shippingMethod, 'shippingMethod', state.shippingMethods.map((m) => m.code)) as ShippingMethodCode;
    const address = objectWith(body.shippingAddress, ADDRESS_FIELDS, 'shippingAddress');
    const shippingAddress = {
      firstName: text(address.firstName, 'shippingAddress.firstName', 1, 100),
      lastName: text(address.lastName, 'shippingAddress.lastName', 1, 100),
      street: text(address.street, 'shippingAddress.street', 1, 200),
      postalCode: text(address.postalCode, 'shippingAddress.postalCode', 1, 20),
      city: text(address.city, 'shippingAddress.city', 1, 100),
      countryCode: text(address.countryCode, 'shippingAddress.countryCode', 2, 2),
    };
    if (!/^[A-Z]{2}$/.test(shippingAddress.countryCode)) {
      throw new MockApiError(400, 'VALIDATION_ERROR', 'shippingAddress.countryCode must be two capital letters');
    }
    const payment = objectWith(body.payment, ['cardNumber'], 'payment');
    if (typeof payment.cardNumber !== 'string' || !/^\d{12,19}$/.test(payment.cardNumber)) {
      throw new MockApiError(400, 'VALIDATION_ERROR', 'payment.cardNumber must have 12-19 digits');
    }
    const paymentAccepted = !payment.cardNumber.endsWith('0');

    const { userId } = requireIdentity(ctx);
    const cart = state.carts[userId] ?? [];
    if (cart.length === 0) {
      throw new MockApiError(409, 'CART_EMPTY', 'Cart is empty');
    }
    const lines = cart.map((item) => {
      const product = state.products.find((p) => p.id === item.productId);
      if (!product) {
        // Withdrawn by the admin after it was put in the cart (Product answers 404).
        throw new MockApiError(409, 'PRODUCT_UNAVAILABLE', `Product ${item.productId} is no longer available`);
      }
      const stock = state.stock[item.productId];
      if (!stock || stock.quantity - stock.reserved < item.quantity) {
        throw new MockApiError(409, 'INSUFFICIENT_STOCK', `Not enough stock of product ${item.productId}`);
      }
      return { product, quantity: item.quantity };
    });

    const method = state.shippingMethods.find((m) => m.code === shippingMethod);
    const shippingCents = parseMoney(method?.price ?? '0.00', MONEY_PATTERN) ?? 0;
    const itemsCents = lines.reduce((sum, l) => sum + l.product.priceCents * l.quantity, 0);
    const timestamp = now();
    const order: OrderDetail = {
      id: crypto.randomUUID(),
      userId,
      status: paymentAccepted ? 'PAID' : 'PAYMENT_FAILED',
      items: lines.map(({ product, quantity }) => ({
        productId: product.id,
        name: product.name,
        unitPrice: toMoney(product.priceCents),
        quantity,
        subtotal: toMoney(product.priceCents * quantity),
      })),
      itemsTotal: toMoney(itemsCents),
      shippingMethod,
      shippingCost: toMoney(shippingCents),
      total: toMoney(itemsCents + shippingCents),
      currency: 'PLN',
      shippingAddress,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    state.orders.push(order);

    if (paymentAccepted) {
      lines.forEach(({ product, quantity }) => {
        state.stock[product.id].reserved += quantity;
      });
      state.carts[userId] = [];
      state.shipments.push({
        id: crypto.randomUUID(),
        orderId: order.id,
        userId,
        status: 'PREPARING',
        method: shippingMethod,
        trackingNumber: null,
        history: [{ status: 'PREPARING', at: timestamp }],
        createdAt: timestamp,
        updatedAt: timestamp,
        visibleAt: new Date(Date.now() + mockConfig.shipmentDelayMs).toISOString(),
      });
    }
    return json(order, 201);
  }),

  route('GET', '/orders', (ctx) => {
    const { userId } = requireIdentity(ctx);
    const paging = pageRequest(ctx.url);
    return json(pageOf(newestFirst(ctx.state.orders.filter((o) => o.userId === userId)).map(summary), paging));
  }),

  route('GET', '/orders/:orderId', (ctx) =>
    json(ownOrder(ctx.state, requireIdentity(ctx), pathUuid(ctx.params, 'orderId'))),
  ),

  route('POST', '/orders/:orderId/cancel', (ctx) => {
    const orderId = pathUuid(ctx.params, 'orderId');
    const { state } = ctx;
    const order = ownOrder(state, requireIdentity(ctx), orderId);
    const shipment = state.shipments.find((s) => s.orderId === order.id);
    const cancellable = (order.status === 'NEW' || order.status === 'PAID') && (!shipment || shipment.status === 'PREPARING');
    if (!cancellable) {
      throw new MockApiError(409, 'ORDER_NOT_CANCELLABLE', `Order in status ${order.status} cannot be cancelled`);
    }
    const timestamp = now();
    order.status = 'CANCELLED';
    order.updatedAt = timestamp;
    // order.cancelled: Inventory releases the reservation, Shipping cancels the shipment a moment later.
    order.items.forEach((item) => {
      const stock = state.stock[item.productId];
      if (stock) {
        stock.reserved = Math.max(0, stock.reserved - item.quantity);
      }
    });
    if (shipment) {
      shipment.cancelAt = new Date(Date.parse(timestamp) + mockConfig.shipmentDelayMs).toISOString();
      applyPlannedCancel(shipment, timestamp); // at once when the delay is 0 (Vitest)
    }
    return json(order);
  }),
];
