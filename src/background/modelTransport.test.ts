import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MODEL_TRANSPORT_PORT_NAME } from "../shared/modelTransport";
import { registerModelTransportBroker, requestModelThroughSidePanel } from "./modelTransport";

interface MockEvent<T extends (...args: never[]) => void> {
  addListener: ReturnType<typeof vi.fn>;
  emit: (...args: Parameters<T>) => void;
}

interface MockPort {
  port: chrome.runtime.Port;
  postMessage: ReturnType<typeof vi.fn>;
  messages: MockEvent<(message: unknown) => void>;
  disconnects: MockEvent<() => void>;
}

const connections = createMockEvent<(port: chrome.runtime.Port) => void>();
let currentPort: MockPort | undefined;

beforeAll(() => {
  vi.stubGlobal("chrome", {
    runtime: {
      onConnect: connections,
    },
  });
  registerModelTransportBroker();
});

afterEach(() => {
  currentPort?.disconnects.emit();
  currentPort = undefined;
  vi.useRealTimers();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("side-panel model transport broker", () => {
  it("returns a response from the connected side panel", async () => {
    currentPort = connectPort();
    const requestPromise = requestModelThroughSidePanel(createRequest());
    const request = getFetchRequest(currentPort);

    currentPort.messages.emit({
      type: "MODEL_TRANSPORT_RESULT",
      requestId: request.requestId,
      response: {
        ok: true,
        status: 200,
        statusText: "OK",
        responseText: "response body",
      },
    });

    await expect(requestPromise).resolves.toMatchObject({
      ok: true,
      status: 200,
      responseText: "response body",
    });
  });

  it("propagates request cancellation to the side-panel fetch", async () => {
    currentPort = connectPort();
    const controller = new AbortController();
    const requestPromise = requestModelThroughSidePanel(createRequest(controller.signal));
    const request = getFetchRequest(currentPort);

    controller.abort();

    await expect(requestPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(currentPort.postMessage).toHaveBeenCalledWith({
      type: "MODEL_TRANSPORT_CANCEL",
      requestId: request.requestId,
    });
  });

  it("rejects an active request when its side panel disconnects", async () => {
    currentPort = connectPort();
    const requestPromise = requestModelThroughSidePanel(createRequest());
    getFetchRequest(currentPort);

    currentPort.disconnects.emit();

    await expect(requestPromise).rejects.toThrow("side panel closed");
    currentPort = undefined;
  });

  it("waits for the side-panel transport to reconnect before starting a request", async () => {
    const requestPromise = requestModelThroughSidePanel(createRequest());

    currentPort = connectPort();
    await Promise.resolve();
    const request = getFetchRequest(currentPort);
    currentPort.messages.emit({
      type: "MODEL_TRANSPORT_RESULT",
      requestId: request.requestId,
      response: {
        ok: true,
        status: 200,
        statusText: "OK",
        responseText: "response after reconnect",
      },
    });

    await expect(requestPromise).resolves.toMatchObject({
      ok: true,
      responseText: "response after reconnect",
    });
  });

  it("cancels a request while waiting for the transport to reconnect", async () => {
    const controller = new AbortController();
    const requestPromise = requestModelThroughSidePanel(createRequest(controller.signal));

    controller.abort();

    await expect(requestPromise).rejects.toMatchObject({ name: "AbortError" });
    currentPort = connectPort();
    await Promise.resolve();
    expect(currentPort.postMessage).not.toHaveBeenCalled();
  });

  it("rejects when the transport does not reconnect promptly", async () => {
    vi.useFakeTimers();
    const requestPromise = requestModelThroughSidePanel(createRequest());
    const rejection = expect(requestPromise).rejects.toThrow("model transport is not connected");

    await vi.advanceTimersByTimeAsync(2_000);

    await rejection;
  });
});

function connectPort(): MockPort {
  const mockPort = createMockPort();
  connections.emit(mockPort.port);
  return mockPort;
}

function createRequest(signal = new AbortController().signal) {
  return {
    endpoint: "https://api.example.test/v1/chat/completions",
    headers: { Authorization: "Bearer test-key" },
    body: "{}",
    signal,
  };
}

function getFetchRequest(mockPort: MockPort): {
  type: "MODEL_TRANSPORT_FETCH";
  requestId: string;
} {
  expect(mockPort.postMessage).toHaveBeenCalledTimes(1);
  const message = mockPort.postMessage.mock.calls[0][0] as {
    type: "MODEL_TRANSPORT_FETCH";
    requestId: string;
  };
  expect(message.type).toBe("MODEL_TRANSPORT_FETCH");
  expect(message.requestId).toBeTruthy();
  return message;
}

function createMockPort(): MockPort {
  const messages = createMockEvent<(message: unknown) => void>();
  const disconnects = createMockEvent<() => void>();
  const postMessage = vi.fn();
  const port = {
    name: MODEL_TRANSPORT_PORT_NAME,
    postMessage,
    onMessage: messages,
    onDisconnect: disconnects,
  } as unknown as chrome.runtime.Port;
  return { port, postMessage, messages, disconnects };
}

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