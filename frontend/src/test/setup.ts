import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { createTestBroadcastChannel } from './broadcast-channel';

afterEach(() => {
  cleanup();
});

// jsdom has no Web Locks API (pitfall 10): a minimal exclusive lock manager, FIFO per lock name.
class TestLockManager {
  private tails = new Map<string, Promise<unknown>>();

  request<T>(name: string, ...args: [(lock: unknown) => T | Promise<T>] | [object, (lock: unknown) => T | Promise<T>]): Promise<T> {
    const callback = args.length === 1 ? args[0] : args[1];
    const previous = this.tails.get(name) ?? Promise.resolve();
    const result = previous.then(() => callback({ name, mode: 'exclusive' }));
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(name, tail);
    void tail.then(() => {
      if (this.tails.get(name) === tail) this.tails.delete(name);
    });
    return result;
  }
}

// Browser stand-ins only in the jsdom environment (a file may run with `@vitest-environment node`).
const inBrowserEnvironment = typeof window !== 'undefined';

if (inBrowserEnvironment && !('locks' in navigator)) {
  Object.defineProperty(navigator, 'locks', { value: new TestLockManager(), configurable: true });
}

// BroadcastChannel between "tabs" of one test process (only when the runtime has none).
if (inBrowserEnvironment && typeof globalThis.BroadcastChannel === 'undefined') {
  Object.defineProperty(globalThis, 'BroadcastChannel', { value: createTestBroadcastChannel(), configurable: true });
}

// jsdom has no matchMedia (sonner reads the system theme): always the light theme.
if (inBrowserEnvironment && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList,
  });
}

// jsdom has no ResizeObserver (Radix RadioGroup, Checkbox and Select use it): an observer that never reports.
if (inBrowserEnvironment && typeof window.ResizeObserver === 'undefined') {
  class TestResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(window, 'ResizeObserver', { value: TestResizeObserver, configurable: true });
  Object.defineProperty(globalThis, 'ResizeObserver', { value: TestResizeObserver, configurable: true });
}
