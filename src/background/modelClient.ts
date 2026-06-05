import type { AgentModelResponse, AgentSettings } from "../shared/types";

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

interface OpenAiChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

export class ModelClientError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "ModelClientError";
  }
}

export async function requestAgentStep(
  settings: AgentSettings,
  messages: ChatMessage[]
): Promise<AgentModelResponse> {
  const endpoint = buildChatCompletionsUrl(settings.apiBaseUrl);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    let { response, responseText } = await postChatCompletion({
      endpoint,
      settings,
      messages,
      signal: controller.signal,
      includeResponseFormat: true
    });

    if (!response.ok && shouldRetryWithoutResponseFormat(response.status, responseText)) {
      ({ response, responseText } = await postChatCompletion({
        endpoint,
        settings,
        messages,
        signal: controller.signal,
        includeResponseFormat: false
      }));
    }

    if (!response.ok) {
      throw new ModelClientError(formatHttpError(response.status, responseText), response.status);
    }

    let data: OpenAiChatCompletionResponse;
    try {
      data = JSON.parse(responseText) as OpenAiChatCompletionResponse;
    } catch {
      throw new ModelClientError("The model provider returned a non-JSON HTTP response.");
    }

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new ModelClientError(data.error?.message || "The model response did not include content.");
    }

    return parseAgentJson(content);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function postChatCompletion(args: {
  endpoint: string;
  settings: AgentSettings;
  messages: ChatMessage[];
  signal: AbortSignal;
  includeResponseFormat: boolean;
}): Promise<{ response: Response; responseText: string }> {
  const body: Record<string, unknown> = {
    model: args.settings.model,
    messages: args.messages,
    temperature: 0.2
  };

  if (args.includeResponseFormat) {
    body.response_format = { type: "json_object" };
  }

  logAiRequestPayload({
    endpoint: args.endpoint,
    provider: args.settings.provider,
    body,
    includeResponseFormat: args.includeResponseFormat
  });

  const response = await fetch(args.endpoint, {
    method: "POST",
    signal: args.signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${args.settings.apiKey}`
    },
    body: JSON.stringify(body)
  });

  return {
    response,
    responseText: await response.text()
  };
}

function logAiRequestPayload(args: {
  endpoint: string;
  provider: AgentSettings["provider"];
  body: Record<string, unknown>;
  includeResponseFormat: boolean;
}): void {
  const payload = {
    endpoint: args.endpoint,
    method: "POST",
    provider: args.provider,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer [redacted]"
    },
    body: args.body
  };

  console.groupCollapsed(
    `[BYOK Agent] Full AI request payload (${args.provider}, response_format=${
      args.includeResponseFormat ? "on" : "off"
    })`
  );
  console.info(payload);
  console.info("Request body JSON:", JSON.stringify(args.body, null, 2));
  console.groupEnd();
}

function shouldRetryWithoutResponseFormat(status: number, body: string): boolean {
  return status === 400 && /response_format|json_object|unsupported parameter|unknown field/i.test(body);
}

function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (!trimmed) {
    throw new ModelClientError("API base URL is required.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ModelClientError("API base URL is invalid.");
  }

  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new ModelClientError("Use HTTPS for API base URLs, except local development hosts.");
  }

  if (parsed.pathname.endsWith("/chat/completions")) {
    return parsed.toString();
  }

  return `${trimmed}/chat/completions`;
}

function formatHttpError(status: number, body: string): string {
  let providerMessage = body.slice(0, 500);
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
    providerMessage = parsed.error?.message || parsed.message || providerMessage;
  } catch {
    // Keep the text preview.
  }

  if (status === 401 || status === 403) {
    return `The model provider rejected the API key or permissions (${status}). ${providerMessage}`;
  }
  if (status === 404) {
    return `The model endpoint or model name was not found (${status}). ${providerMessage}`;
  }
  if (status === 429) {
    return `The model provider rate limited the request (${status}). ${providerMessage}`;
  }
  return `The model provider returned HTTP ${status}. ${providerMessage}`;
}

function parseAgentJson(content: string): AgentModelResponse {
  const jsonText = extractJsonObject(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new ModelClientError("The model did not return strict JSON.");
  }

  if (!isAgentModelResponse(parsed)) {
    throw new ModelClientError("The model JSON did not match the required action schema.");
  }

  return parsed;
}

function extractJsonObject(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return trimmed.slice(first, last + 1);
  }

  return trimmed;
}

function isAgentModelResponse(value: unknown): value is AgentModelResponse {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.thought_summary !== "string") {
    return false;
  }

  if (!["low", "medium", "high"].includes(String(value.risk_level))) {
    return false;
  }

  if (!isRecord(value.action) || typeof value.action.type !== "string") {
    return false;
  }

  const actionTypes = ["click", "drag", "fill", "type", "select", "press_key", "scroll", "navigate", "extract", "ask_user", "done"];
  return actionTypes.includes(value.action.type);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
