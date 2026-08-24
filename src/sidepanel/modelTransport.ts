import {
  MODEL_TRANSPORT_HEARTBEAT_MS,
  MODEL_TRANSPORT_PORT_NAME,
  type BackgroundToModelTransportMessage,
  type ModelTransportToBackgroundMessage,
} from "../shared/modelTransport";

const RECONNECT_DELAY_MS = 250;

export function connectModelTransport(): () => void {
  let disposed = false;
  let reconnectTimer: number | undefined;
  let activePort: chrome.runtime.Port | undefined;

  const connect = () => {
    if (disposed) {
      return;
    }

    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connect({ name: MODEL_TRANSPORT_PORT_NAME });
    } catch {
      reconnectTimer = window.setTimeout(connect, RECONNECT_DELAY_MS);
      return;
    }

    activePort = port;
    const controllers = new Map<string, AbortController>();
    let heartbeatTimer: number | undefined;

    const updateHeartbeat = () => {
      if (controllers.size > 0 && heartbeatTimer === undefined) {
        heartbeatTimer = window.setInterval(() => {
          postPortMessage(port, { type: "MODEL_TRANSPORT_HEARTBEAT" });
        }, MODEL_TRANSPORT_HEARTBEAT_MS);
      } else if (controllers.size === 0 && heartbeatTimer !== undefined) {
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
    };

    port.onMessage.addListener((message: BackgroundToModelTransportMessage) => {
      if (message.type === "MODEL_TRANSPORT_CANCEL") {
        controllers.get(message.requestId)?.abort();
        return;
      }

      const previousController = controllers.get(message.requestId);
      previousController?.abort();
      const controller = new AbortController();
      controllers.set(message.requestId, controller);
      updateHeartbeat();

      void performModelFetch(message, controller.signal)
        .then((response) => {
          if (!controller.signal.aborted) {
            postPortMessage(port, {
              type: "MODEL_TRANSPORT_RESULT",
              requestId: message.requestId,
              response,
            });
          }
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            postPortMessage(port, {
              type: "MODEL_TRANSPORT_ERROR",
              requestId: message.requestId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        })
        .finally(() => {
          if (controllers.get(message.requestId) === controller) {
            controllers.delete(message.requestId);
          }
          updateHeartbeat();
        });
    });

    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (heartbeatTimer !== undefined) {
        window.clearInterval(heartbeatTimer);
      }
      for (const controller of controllers.values()) {
        controller.abort();
      }
      controllers.clear();
      if (activePort === port) {
        activePort = undefined;
      }
      if (!disposed) {
        reconnectTimer = window.setTimeout(connect, RECONNECT_DELAY_MS);
      }
    });
  };

  connect();

  return () => {
    disposed = true;
    if (reconnectTimer !== undefined) {
      window.clearTimeout(reconnectTimer);
    }
    activePort?.disconnect();
    activePort = undefined;
  };
}

async function performModelFetch(
  message: Extract<BackgroundToModelTransportMessage, { type: "MODEL_TRANSPORT_FETCH" }>,
  signal: AbortSignal,
) {
  const response = await fetch(message.endpoint, {
    method: "POST",
    signal,
    headers: message.headers,
    body: message.body,
  });
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    responseText: await response.text(),
  };
}

function postPortMessage(port: chrome.runtime.Port, message: ModelTransportToBackgroundMessage): void {
  try {
    port.postMessage(message);
  } catch {
    // Disconnect handling aborts active requests and reconnects the transport.
  }
}