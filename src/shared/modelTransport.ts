export const MODEL_TRANSPORT_PORT_NAME = "byok-model-transport";
export const MODEL_TRANSPORT_HEARTBEAT_MS = 10_000;

export interface ModelTransportFetchRequest {
  type: "MODEL_TRANSPORT_FETCH";
  requestId: string;
  endpoint: string;
  headers: Record<string, string>;
  body: string;
}

export interface ModelTransportCancelRequest {
  type: "MODEL_TRANSPORT_CANCEL";
  requestId: string;
}

export interface ModelTransportFetchResult {
  type: "MODEL_TRANSPORT_RESULT";
  requestId: string;
  response: {
    ok: boolean;
    status: number;
    statusText: string;
    responseText: string;
  };
}

export interface ModelTransportFetchError {
  type: "MODEL_TRANSPORT_ERROR";
  requestId: string;
  message: string;
}

export interface ModelTransportHeartbeat {
  type: "MODEL_TRANSPORT_HEARTBEAT";
}

export type BackgroundToModelTransportMessage =
  | ModelTransportFetchRequest
  | ModelTransportCancelRequest;

export type ModelTransportToBackgroundMessage =
  | ModelTransportFetchResult
  | ModelTransportFetchError
  | ModelTransportHeartbeat;