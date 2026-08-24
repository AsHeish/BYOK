// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_TRANSPORT_PORT_NAME } from "../shared/modelTransport";
import { connectModelTransport } from "./modelTransport";

interface MockEvent<T extends (...args: never[]) => void> {
  addListener: ReturnType<typeof vi.fn>;
  emit: (...args: Parameters<T>) => void;
}

const messages = createMockEvent<(message: unknown) => void>();
const disconnects = createMockEvent<() => void>();
const postMessage = vi.fn();
const disconnect = vi.fn(() => disconnects.emit());
const port = {
  name: MODEL_TRANSPORT_PORT_NAME,
  postMessage,
  disconnect,
  onMessage: messages,
  onDisconnect: disconnects,
} as unknown as chrome.runtime.Port;

beforeEach(() => {
  vi.useFakeTimers();
  postMessage.mockClear();
  disconnect.mockClear();
  vi.stubGlobal("chrome", {
    runtime: {
      connect: vi.fn(() => port),
      lastError: undefined,
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("side-panel model fetch host", () => {
  it("keeps a fetch alive past 30 seconds and aborts it on request", async () => {
    let fetchAborted = false;
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        fetchAborted = true;
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const disconnectTransport = connectModelTransport();

    messages.emit({
      type: "MODEL_TRANSPORT_FETCH",
      requestId: "request-1",
      endpoint: "https://api.example.test/v1/chat/completions",
      headers: { Authorization: "Bearer test-key" },
      body: "{}",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(fetchAborted).toBe(false);
    expect(postMessage.mock.calls.filter(([message]) => (
      (message as { type?: string }).type === "MODEL_TRANSPORT_HEARTBEAT"
    ))).toHaveLength(3);

    messages.emit({ type: "MODEL_TRANSPORT_CANCEL", requestId: "request-1" });
    await Promise.resolve();

    expect(fetchAborted).toBe(true);
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "MODEL_TRANSPORT_ERROR",
      requestId: "request-1",
    }));
    disconnectTransport();
  });
});

function createMockEvent<T extends (...args: never[]) => void>(): MockEvent<T> {
  const listeners: T[] = [];
  return {
    addListener: vi.fn((listener: T) => listeners.push(listener)),
    emit: (...args: Parameters<T>) => {
      for (const listener of [...listeners]) {
        listener(...args);
      }
    },
  };
}