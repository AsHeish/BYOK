import { createId } from "../shared/ids";
import {
  MODEL_TRANSPORT_PORT_NAME,
  type BackgroundToModelTransportMessage,
  type ModelTransportToBackgroundMessage,
} from "../shared/modelTransport";
import type {
  ModelHttpRequest,
  ModelHttpResponse,
  ModelRequestTransport,
} from "./modelClient";

interface PendingModelRequest {
  port: chrome.runtime.Port;
  signal: AbortSignal;
  onAbort: () => void;
  resolve: (response: ModelHttpResponse) => void;
  reject: (error: Error) => void;
}

const MODEL_TRANSPORT_CONNECT_TIMEOUT_MS = 2_000;
const connectedPorts: chrome.runtime.Port[] = [];
const pendingRequests = new Map<string, PendingModelRequest>();
const pendingPortConnections = new Set<(port: chrome.runtime.Port) => void>();

export function registerModelTransportBroker(): void {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== MODEL_TRANSPORT_PORT_NAME) {
      return;
    }

    connectedPorts.push(port);
    for (const handleConnection of [...pendingPortConnections]) {
      handleConnection(port);
    }
    port.onMessage.addListener((message: ModelTransportToBackgroundMessage) => {
      handleTransportMessage(port, message);
    });
    port.onDisconnect.addListener(() => {
      const index = connectedPorts.lastIndexOf(port);
      if (index >= 0) {
        connectedPorts.splice(index, 1);
      }
      rejectRequestsForPort(port, "The side panel closed during the model request. Reopen it and rerun the message.");
    });
  });
}

export const requestModelThroughSidePanel: ModelRequestTransport = (
  request: ModelHttpRequest,
): Promise<ModelHttpResponse> => {
  if (request.signal.aborted) {
    return Promise.reject(createAbortError());
  }

  const port = connectedPorts.at(-1);
  if (!port) {
    return waitForConnectedPort(request.signal)
      .then((connectedPort) => requestModelThroughPort(connectedPort, request));
  }

  return requestModelThroughPort(port, request);
};

function requestModelThroughPort(
  port: chrome.runtime.Port,
  request: ModelHttpRequest,
): Promise<ModelHttpResponse> {
  if (request.signal.aborted) {
    return Promise.reject(createAbortError());
  }

  const requestId = createId("model-request");
  return new Promise<ModelHttpResponse>((resolve, reject) => {
    const onAbort = () => {
      const pending = pendingRequests.get(requestId);
      if (!pending) {
        return;
      }
      clearPendingRequest(requestId, pending);
      postPortMessage(port, { type: "MODEL_TRANSPORT_CANCEL", requestId });
      reject(createAbortError());
    };
    const pending: PendingModelRequest = {
      port,
      signal: request.signal,
      onAbort,
      resolve,
      reject,
    };
    pendingRequests.set(requestId, pending);
    request.signal.addEventListener("abort", onAbort, { once: true });

    try {
      port.postMessage({
        type: "MODEL_TRANSPORT_FETCH",
        requestId,
        endpoint: request.endpoint,
        headers: request.headers,
        body: request.body,
      } satisfies BackgroundToModelTransportMessage);
    } catch (error) {
      clearPendingRequest(requestId, pending);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function waitForConnectedPort(signal: AbortSignal): Promise<chrome.runtime.Port> {
  return new Promise((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const settle = (result: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      pendingPortConnections.delete(handleConnection);
      signal.removeEventListener("abort", handleAbort);
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      result();
    };
    const handleConnection = (port: chrome.runtime.Port) => settle(() => resolve(port));
    const handleAbort = () => settle(() => reject(createAbortError()));

    pendingPortConnections.add(handleConnection);
    signal.addEventListener("abort", handleAbort, { once: true });
    timeoutId = setTimeout(() => {
      settle(() => reject(new Error(
        "The side-panel model transport is not connected. Reopen the side panel and rerun the message.",
      )));
    }, MODEL_TRANSPORT_CONNECT_TIMEOUT_MS);

    if (signal.aborted) {
      handleAbort();
    }
  });
}

function handleTransportMessage(
  port: chrome.runtime.Port,
  message: ModelTransportToBackgroundMessage,
): void {
  if (message.type === "MODEL_TRANSPORT_HEARTBEAT") {
    return;
  }

  const pending = pendingRequests.get(message.requestId);
  if (!pending || pending.port !== port) {
    return;
  }
  clearPendingRequest(message.requestId, pending);

  if (message.type === "MODEL_TRANSPORT_ERROR") {
    pending.reject(new Error(message.message));
    return;
  }
  pending.resolve(message.response);
}

function rejectRequestsForPort(port: chrome.runtime.Port, message: string): void {
  for (const [requestId, pending] of pendingRequests) {
    if (pending.port !== port) {
      continue;
    }
    clearPendingRequest(requestId, pending);
    pending.reject(new Error(message));
  }
}

function clearPendingRequest(requestId: string, pending: PendingModelRequest): void {
  pendingRequests.delete(requestId);
  pending.signal.removeEventListener("abort", pending.onAbort);
}

function postPortMessage(port: chrome.runtime.Port, message: BackgroundToModelTransportMessage): void {
  try {
    port.postMessage(message);
  } catch {
    // The pending request is already rejected locally when cancellation wins.
  }
}

function createAbortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}