// Mock Cart (contract: docs/frontend-api.md, section Cart). Name and price are copied from the product
// on every change; stock comes from the mock Inventory (no stock record = 0 pieces -> 409; Inventory
// "unavailable" -> inventoryChecked: false).
import type { Cart, CartMutationResponse } from '../../api/types';
import type { MockState } from '../db';
import { json, MockApiError, noContent, notFound, requireIdentity, route } from '../http';
import { toMoney } from '../money';
import { integer, pathUuid, readBody, uuid } from '../validation';
import { availableOf } from './inventory';

export function cartView(state: MockState, userId: string): Cart {
  const items = (state.carts[userId] ?? []).map((item) => ({
    productId: item.productId,
    name: item.name,
    unitPrice: toMoney(item.unitPriceCents),
    quantity: item.quantity,
    subtotal: toMoney(item.unitPriceCents * item.quantity),
  }));
  const totalCents = (state.carts[userId] ?? []).reduce((sum, i) => sum + i.unitPriceCents * i.quantity, 0);
  return { userId, currency: 'PLN', items, total: toMoney(totalCents) };
}

function changeItem(state: MockState, userId: string, productId: string, amount: number, add: boolean): CartMutationResponse {
  const product = state.products.find((p) => p.id === productId);
  if (!product) {
    throw notFound('Product not found');
  }
  const cart = state.carts[userId] ?? [];
  const existing = cart.find((i) => i.productId === productId);
  if (!add && !existing) {
    throw notFound('Item is not in the cart');
  }
  const quantity = add ? (existing?.quantity ?? 0) + amount : amount;
  if (quantity > 999) {
    throw new MockApiError(409, 'CONFLICT', 'At most 999 pieces of a product');
  }
  const available = availableOf(state, productId);
  if (available !== null && quantity > available) {
    throw new MockApiError(409, 'CONFLICT', 'Not enough pieces in stock');
  }
  const item = { productId, name: product.name, unitPriceCents: product.priceCents, quantity };
  state.carts[userId] = existing ? cart.map((i) => (i.productId === productId ? item : i)) : [...cart, item];
  return { ...cartView(state, userId), inventoryChecked: available !== null };
}

export const cartHandlers = [
  route('GET', '/cart', (ctx) => json(cartView(ctx.state, requireIdentity(ctx).userId))),

  route('POST', '/cart/items', (ctx) => {
    const body = readBody(ctx.body, ['productId', 'quantity']);
    const productId = uuid(body.productId, 'productId');
    const quantity = integer(body.quantity, 'quantity', 1, 999);
    return json(changeItem(ctx.state, requireIdentity(ctx).userId, productId, quantity, true));
  }),

  route('PATCH', '/cart/items/:productId', (ctx) => {
    const productId = pathUuid(ctx.params, 'productId');
    const body = readBody(ctx.body, ['quantity']);
    const quantity = integer(body.quantity, 'quantity', 1, 999);
    return json(changeItem(ctx.state, requireIdentity(ctx).userId, productId, quantity, false));
  }),

  route('DELETE', '/cart/items/:productId', (ctx) => {
    const productId = pathUuid(ctx.params, 'productId');
    const userId = requireIdentity(ctx).userId;
    ctx.state.carts[userId] = (ctx.state.carts[userId] ?? []).filter((i) => i.productId !== productId);
    return noContent();
  }),
];
