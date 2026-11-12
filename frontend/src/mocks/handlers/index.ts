// All mock handlers: exactly the endpoints of the table in docs/frontend-api.md (checked by src/api/contract.test.ts).
import type { HttpHandler } from 'msw';
import { API_PREFIX } from '../http';
import { authHandlers } from './auth';
import { cartHandlers } from './cart';
import { inventoryHandlers } from './inventory';
import { orderHandlers } from './orders';
import { productHandlers } from './products';
import { reviewHandlers } from './reviews';
import { shippingHandlers } from './shipping';
import { userHandlers } from './users';

export const handlers: HttpHandler[] = [
  ...authHandlers,
  ...userHandlers,
  ...cartHandlers,
  ...productHandlers,
  ...inventoryHandlers,
  ...reviewHandlers,
  ...orderHandlers,
  ...shippingHandlers,
];

/** Contract path of a handler: `/products/{productId}` (without /api/v1, `:param` -> `{param}`). */
export function contractPath(handler: HttpHandler): string {
  return String(handler.info.path)
    .slice(API_PREFIX.length)
    .replace(/:([A-Za-z]+)/g, '{$1}');
}

/** First path segment of a handler (`products`, `categories`, `auth`…), the unit of VITE_API_MOCKS. */
export function resourceOf(handler: HttpHandler): string {
  return contractPath(handler).split('/')[1];
}
