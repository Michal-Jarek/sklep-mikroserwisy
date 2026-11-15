// Idempotency-Key of POST /orders (wytyczne 3.8). The key lives only in the memory of the checkout page:
// the same key while the purchase may still exist on the server, a new one after it ended or the data changed.
import { useMemo, useRef } from 'react';
import { ApiError } from '@/api/errors';
import type { CreateOrderRequest } from '@/api/types';

export interface OrderAttempt {
  key: string;
  /** SHA-256 of the request body: tells whether the form data changed without keeping the card number. */
  fingerprint: string;
}

export async function orderFingerprint(order: CreateOrderRequest): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(order)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Key of the next POST /orders: the previous attempt's key for the same data, otherwise a new one. */
export function attemptFor(previous: OrderAttempt | null, fingerprint: string): OrderAttempt {
  return previous?.fingerprint === fingerprint ? previous : { key: crypto.randomUUID(), fingerprint };
}

/**
 * True when the order may exist or still be in progress on the server, so a retry must use the same key:
 * no response (network error, timeout, aborted request), 408 and 5xx. 201 and the other 4xx end the attempt.
 */
export function keepsKey(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status === 0 || error.status === 408 || error.status >= 500;
}

/**
 * Idempotency-Key of the checkout page: `keyFor(order)` before every POST /orders, `settle(error?)` after it
 * (no error = 201). The key stays only in this ref.
 */
export function useIdempotencyKey() {
  const attempt = useRef<OrderAttempt | null>(null);
  return useMemo(
    () => ({
      async keyFor(order: CreateOrderRequest): Promise<string> {
        attempt.current = attemptFor(attempt.current, await orderFingerprint(order));
        return attempt.current.key;
      },
      settle(error?: unknown): void {
        if (error === undefined || !keepsKey(error)) attempt.current = null;
      },
    }),
    [],
  );
}
