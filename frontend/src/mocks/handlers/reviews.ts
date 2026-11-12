// Mock Review (contract: docs/frontend-api.md, section Review). "Bought" = an order PAID, SHIPPED or DELIVERED
// with the product, as Review would ask Order (GET /orders/purchased).
import type { Review } from '../../api/types';
import type { MockState } from '../db';
import { isAdmin, json, MockApiError, noContent, notFound, now, requireIdentity, route } from '../http';
import { integer, newestFirst, pageOf, pageRequest, pathUuid, readBody, uuid } from '../validation';

const PURCHASED_STATUSES = ['PAID', 'SHIPPED', 'DELIVERED'];

function hasPurchased(state: MockState, userId: string, productId: string): boolean {
  return state.orders.some(
    (o) => o.userId === userId && PURCHASED_STATUSES.includes(o.status) && o.items.some((i) => i.productId === productId),
  );
}

function comment(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string' || value.length > 2000) {
    throw new MockApiError(400, 'VALIDATION_ERROR', 'comment must be text up to 2000 characters or null');
  }
  return value.trim() === '' ? null : value.trim();
}

export const reviewHandlers = [
  route('GET', '/reviews', ({ url, state }) => {
    const productId = uuid(url.searchParams.get('productId'), 'productId');
    const paging = pageRequest(url);
    return json(pageOf(newestFirst(state.reviews.filter((r) => r.productId === productId)), paging));
  }),

  route('POST', '/reviews', async (ctx) => {
    const body = await readBody(ctx.request, ['productId', 'rating', 'comment']);
    const productId = uuid(body.productId, 'productId');
    const rating = integer(body.rating, 'rating', 1, 5);
    const text = comment(body.comment);
    const { userId } = requireIdentity(ctx);
    if (!hasPurchased(ctx.state, userId, productId)) {
      throw new MockApiError(403, 'FORBIDDEN', 'Only a customer who bought the product can review it');
    }
    if (ctx.state.reviews.some((r) => r.productId === productId && r.userId === userId)) {
      throw new MockApiError(409, 'CONFLICT', 'The product is already reviewed by this customer');
    }
    const review: Review = { id: crypto.randomUUID(), productId, userId, rating, comment: text, createdAt: now() };
    ctx.state.reviews.push(review);
    return json(review, 201);
  }),

  route('DELETE', '/reviews/:reviewId', (ctx) => {
    const reviewId = pathUuid(ctx.params, 'reviewId');
    const identity = requireIdentity(ctx);
    const review = ctx.state.reviews.find((r) => r.id === reviewId);
    if (!review) {
      throw notFound('Review not found');
    }
    if (review.userId !== identity.userId && !isAdmin(identity)) {
      throw new MockApiError(403, 'FORBIDDEN', 'Only the author or ADMIN can delete a review');
    }
    ctx.state.reviews = ctx.state.reviews.filter((r) => r.id !== reviewId);
    return noContent();
  }),
];
