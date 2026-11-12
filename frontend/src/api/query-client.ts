// TanStack Query defaults (decision 12): only queries (GET) are retried, at most once, and only after
// 502/503/504 or a network error (the Gateway already retries a missing connection); never 4xx
// (429 shows the wait time instead) and never mutations.
import { QueryClient } from '@tanstack/react-query';
import { isTemporaryError } from '@/api/errors';

export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return failureCount < 1 && isTemporaryError(error);
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetryQuery },
      // gcTime 0: variables of a finished mutation (password of the login form, card number of the order)
      // leave the cache as soon as the form is gone (C5, 3.6).
      mutations: { retry: false, gcTime: 0 },
    },
  });
}
