// Mock Inventory (contract: docs/frontend-api.md, section Inventory).
import type { StockLevel } from '../../api/types';
import type { MockState } from '../db';
import { json, MockApiError, notFound, route } from '../http';
import { integer, pathUuid, readBody } from '../validation';

/**
 * Pieces that can still be reserved, as Product and Cart see them: 0 without a stock record
 * (docs/frontend-api.md: no record = 0 pieces), null when Inventory "does not answer"
 * (product flag inventoryUnavailable).
 */
export function availableOf(state: MockState, productId: string): number | null {
  if (state.products.find((p) => p.id === productId)?.inventoryUnavailable) {
    return null;
  }
  const stock = state.stock[productId];
  return stock ? stock.quantity - stock.reserved : 0;
}

function stockView(state: MockState, productId: string): StockLevel {
  const { quantity, reserved } = state.stock[productId];
  const available = quantity - reserved;
  return { productId, quantity, reserved, available, inStock: available > 0 };
}

export const inventoryHandlers = [
  route('GET', '/inventory/:productId', ({ params, state }) => {
    const productId = pathUuid(params, 'productId');
    if (!state.stock[productId]) {
      throw notFound('No stock record for the product');
    }
    return json(stockView(state, productId));
  }),

  route('PUT', '/inventory/:productId', async ({ params, request, state }) => {
    const productId = pathUuid(params, 'productId');
    const body = await readBody(request, ['quantity']);
    const quantity = integer(body.quantity, 'quantity', 0, 1_000_000);
    const reserved = state.stock[productId]?.reserved ?? 0;
    if (quantity < reserved) {
      throw new MockApiError(409, 'CONFLICT', `New quantity (${quantity}) is lower than reserved (${reserved})`);
    }
    state.stock[productId] = { quantity, reserved };
    return json(stockView(state, productId));
  }),
];
