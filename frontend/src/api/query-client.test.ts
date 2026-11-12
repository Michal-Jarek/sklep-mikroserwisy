import { describe, expect, it } from 'vitest';
import { ApiError, NETWORK_ERROR } from '@/api/errors';
import { createQueryClient, shouldRetryQuery } from '@/api/query-client';

function apiError(status: number, code = 'X'): ApiError {
  return new ApiError({ status, code, message: '', requestId: null, retryAfter: null });
}

describe('query retries', () => {
  it('retries a query once after 502, 503, 504 or a network error', () => {
    for (const error of [apiError(502), apiError(503), apiError(504), apiError(0, NETWORK_ERROR)]) {
      expect(shouldRetryQuery(0, error)).toBe(true);
      expect(shouldRetryQuery(1, error)).toBe(false);
    }
  });

  it('never retries 4xx (including 429) or 500', () => {
    for (const status of [400, 401, 403, 404, 409, 429, 500]) expect(shouldRetryQuery(0, apiError(status))).toBe(false);
    expect(shouldRetryQuery(0, new Error('bug'))).toBe(false);
  });

  it('never retries mutations', () => {
    expect(createQueryClient().getDefaultOptions().mutations?.retry).toBe(false);
  });

  it('drops a mutation (and its variables) from the cache as soon as nobody uses it', () => {
    expect(createQueryClient().getDefaultOptions().mutations?.gcTime).toBe(0);
  });
});
