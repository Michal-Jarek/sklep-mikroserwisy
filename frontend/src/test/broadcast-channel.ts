/**
 * In-memory BroadcastChannel: every call returns a class with its own set of channels, so a test can
 * replace the global (vi.stubGlobal) and not hear channels left open by modules of earlier tests.
 */
export function createTestBroadcastChannel(): typeof BroadcastChannel {
  const channels = new Set<TestBroadcastChannel>();

  class TestBroadcastChannel extends EventTarget {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onmessageerror: ((event: MessageEvent) => void) | null = null;
    readonly name: string;

    constructor(name: string) {
      super();
      this.name = name;
      channels.add(this);
    }

    postMessage(data: unknown): void {
      for (const channel of channels) {
        if (channel === this || channel.name !== this.name) continue;
        queueMicrotask(() => {
          const event = new MessageEvent('message', { data });
          channel.onmessage?.(event);
          channel.dispatchEvent(event);
        });
      }
    }

    close(): void {
      channels.delete(this);
    }
  }

  return TestBroadcastChannel as unknown as typeof BroadcastChannel;
}
