// Mocks in Vitest (Node). A test file that needs them calls setupMockServer() at the top level;
// MSW is not started globally (src/test/setup.ts).
import { afterAll, afterEach, beforeAll } from 'vitest';
import { setupServer } from 'msw/node';
import { mockConfig, resetState } from './db';
import { handlers } from './handlers';

export const server = setupServer(...handlers);

/** Starts the mock server for the current test file; after each test: seed data and the original handlers. */
export function setupMockServer(): void {
  beforeAll(() => {
    mockConfig.delayMs = [0, 0];
    mockConfig.shipmentDelayMs = 0;
    resetState();
    server.listen({ onUnhandledFrame: 'error' });
  });
  afterEach(() => {
    server.resetHandlers();
    resetState();
  });
  afterAll(() => {
    server.close();
  });
}
