// window.__mocks: control of the mocks from the browser console and from E2E tests (page.evaluate).
// Playwright page.route does not see requests answered by the MSW service worker, so E2E forces errors here.
import { loadState, resetState, saveState } from './db';
import { defaultErrorCode } from './http';

export interface FailNextOptions {
  /** `error` of the D7 body; default from the status (429 TOO_MANY_REQUESTS, 503 SERVICE_UNAVAILABLE…). */
  error?: string;
  /** Seconds in the Retry-After header; 429 gets 30 when not given. */
  retryAfter?: number;
  /** How many next requests to the resource fail (default 1). */
  times?: number;
  /**
   * Only requests with this method fail and count (default: every method). Needed when the page keeps sending
   * other requests to the resource, e.g. the order page polls GET /orders/{id} every 10 s while the test plans
   * a 409 for POST /orders/{id}/cancel.
   */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
}

export interface MockControls {
  /** Seed data, no session, no planned errors. The caller reloads the page. */
  reset(): void;
  /**
   * The next `times` requests to `resource` (first path segment after /api/v1, e.g. `products`, `auth`)
   * get `status` with a D7 body. Planned errors are kept in the mock state, so they survive a page reload.
   * Every request that reaches the mocks counts, also aborted ones and those the page sends by itself.
   * - The client repeats a GET once after 502/503/504 (decision 12): a later GET (retry button, next page)
   *   needs `times: 2`.
   * - In the dev server <StrictMode> mounts a page twice: TanStack Query aborts the first GET and sends it
   *   again. The MSW service worker does not pass the abort to the handler (request.signal.aborted stays
   *   false, checked in MSW 3.0.3), so the aborted GET uses one error too: a GET on page entry needs `times: 3`.
   */
  failNext(resource: string, status: number, opts?: FailNextOptions): void;
}

export const mockControls: MockControls = {
  reset() {
    resetState();
  },
  failNext(resource, status, opts = {}) {
    const state = loadState();
    const retryAfter = opts.retryAfter ?? (status === 429 ? 30 : undefined);
    state.failures[resource] = {
      status,
      error: opts.error ?? defaultErrorCode(status),
      remaining: opts.times ?? 1,
      ...(retryAfter !== undefined ? { retryAfter } : {}),
      ...(opts.method !== undefined ? { method: opts.method } : {}),
    };
    saveState(state);
  },
};

declare global {
  interface Window {
    __mocks?: MockControls;
  }
}
