import { describe, expect, it } from 'vitest';
import { ApiError, NETWORK_ERROR } from '@/api/errors';
import type { CreateOrderRequest } from '@/api/types';
import { attemptFor, keepsKey, orderFingerprint } from '@/features/checkout/idempotency';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const ORDER: CreateOrderRequest = {
  shippingMethod: 'COURIER',
  shippingAddress: { firstName: 'Jan', lastName: 'Kowalski', street: 'ul. Testowa 1', postalCode: '00-001', city: 'Warszawa', countryCode: 'PL' },
  payment: { cardNumber: '4111111111111111' },
};

const apiError = (status: number, code = 'X') => new ApiError({ status, code, message: '', requestId: null, retryAfter: null });

describe('Idempotency-Key of POST /orders', () => {
  it('the first attempt gets a new UUID v4', async () => {
    const attempt = attemptFor(null, await orderFingerprint(ORDER));
    expect(attempt.key).toMatch(UUID);
  });

  it('the same data keep the key, changed address, method or card get a new one', async () => {
    const first = attemptFor(null, await orderFingerprint(ORDER));
    expect(attemptFor(first, await orderFingerprint(structuredClone(ORDER))).key).toBe(first.key);

    const changed: CreateOrderRequest[] = [
      { ...ORDER, shippingAddress: { ...ORDER.shippingAddress, street: 'ul. Inna 2' } },
      { ...ORDER, shippingMethod: 'PICKUP' },
      { ...ORDER, payment: { cardNumber: '4111111111111112' } },
    ];
    for (const order of changed) {
      const next = attemptFor(first, await orderFingerprint(order));
      expect(next.key).toMatch(UUID);
      expect(next.key).not.toBe(first.key);
    }
  });

  it('the fingerprint does not contain the card number', async () => {
    const fingerprint = await orderFingerprint(ORDER);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).not.toContain('4111');
  });

  it.each([
    [0, NETWORK_ERROR],
    [408, 'REQUEST_TIMEOUT'],
    [500, 'INTERNAL_ERROR'],
    [502, 'BAD_GATEWAY'],
    [503, 'SERVICE_UNAVAILABLE'],
    [504, 'GATEWAY_TIMEOUT'],
  ])('keeps the key after %i %s (the order may exist)', (status, code) => {
    expect(keepsKey(apiError(status, code))).toBe(true);
  });

  it('keeps the key after an aborted request (not an ApiError)', () => {
    expect(keepsKey(new DOMException('aborted', 'AbortError'))).toBe(true);
  });

  it.each([
    [400, 'VALIDATION_ERROR'],
    [401, 'UNAUTHORIZED'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [409, 'INSUFFICIENT_STOCK'],
    [409, 'PRODUCT_UNAVAILABLE'],
    [409, 'CART_EMPTY'],
    [429, 'TOO_MANY_REQUESTS'],
  ])('drops the key after %i %s', (status, code) => {
    expect(keepsKey(apiError(status, code))).toBe(false);
  });
});
