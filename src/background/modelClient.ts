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
  usage?: ChatUsage;
}

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  input_tokens_details?: {
    cached_tokens?: number;
    cache_read?: number;
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
    let includeResponseFormat = true;
    let includePromptCacheFields = shouldUsePromptCacheFields(settings);
    let result: { response: Response; responseText: string } | undefined;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      result = await postChatCompletion({
        endpoint,
        settings,
        messages,
        signal: controller.signal,
        includeResponseFormat,
        includePromptCacheFields
      });

      if (result.response.ok) {
        break;
      }

      if (includePromptCacheFields && shouldRetryWithoutPromptCacheFields(result.response.status, result.responseText)) {
        includePromptCacheFields = false;
        console.warn("[BYOK Agent] Provider rejected prompt cache fields; retrying without them.");
        continue;
      }

      if (includeResponseFormat && shouldRetryWithoutResponseFormat(result.response.status, result.responseText)) {
        includeResponseFormat = false;
        continue;
      }

      break;
    }

    if (!result) {
      throw new ModelClientError("The model request could not be started.");
    }

    const { response, responseText } = result;
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

    logTokenUsage(settings.provider, data.usage);
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
  includePromptCacheFields: boolean;
}): Promise<{ response: Response; responseText: string }> {
  const body: Record<string, unknown> = {
    model: args.settings.model,
    messages: args.messages,
    temperature: 0.2
  };

  if (args.includePromptCacheFields) {
    body.prompt_cache_key = buildPromptCacheKey(args.settings, args.messages);
    body.prompt_cache_retention = "in_memory";
  }

  if (args.includeResponseFormat) {
    body.response_format = { type: "json_object" };
  }

  logAiRequestPayload({
    endpoint: args.endpoint,
    provider: args.settings.provider,
    body,
    messages: args.messages,
    includePromptCacheFields: args.includePromptCacheFields,
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
  messages: ChatMessage[];
  includePromptCacheFields: boolean;
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
    }, prompt_cache=${args.includePromptCacheFields ? "on" : "implicit"})`
  );
  console.info("Prompt cache plan:", buildPromptCacheDebugInfo(args.messages, args.body.prompt_cache_key));
  console.info(payload);
  console.info("Request body JSON:", JSON.stringify(args.body, null, 2));
  console.groupEnd();
}

function shouldRetryWithoutResponseFormat(status: number, body: string): boolean {
  return status === 400 && /response_format|json_object|unsupported parameter|unknown field/i.test(body);
}

function shouldRetryWithoutPromptCacheFields(status: number, body: string): boolean {
  return status === 400 && /prompt_cache_key|prompt_cache_retention|prompt cache|prompt caching/i.test(body);
}

function shouldUsePromptCacheFields(settings: AgentSettings): boolean {
  return settings.provider === "openai";
}

function buildPromptCacheKey(settings: AgentSettings, messages: ChatMessage[]): string {
  const stablePrefix = getStablePromptPrefix(messages);
  const keyMaterial = [settings.apiBaseUrl, settings.model, stablePrefix].join("\n");
  return `byok-agent-${shortHash(keyMaterial)}`;
}

function buildPromptCacheDebugInfo(messages: ChatMessage[], promptCacheKey: unknown): Record<string, unknown> {
  const stablePrefix = getStablePromptPrefix(messages);
  return {
    providerCacheKey: typeof promptCacheKey === "string" ? promptCacheKey : undefined,
    stablePrefixMessages: Math.min(messages.length, 2),
    stablePrefixCharacters: stablePrefix.length,
    estimatedStablePrefixTokens: Math.ceil(stablePrefix.length / 4),
    note:
      "Static instructions and task are kept before changing page observations so provider-side prefix caches can be reused."
  };
}

function getStablePromptPrefix(messages: ChatMessage[]): string {
  return messages
    .slice(0, 2)
    .map((message) => `${message.role}:\n${message.content}`)
    .join("\n\n");
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function logTokenUsage(provider: AgentSettings["provider"], usage: ChatUsage | undefined): void {
  if (!usage) {
    return;
  }

  const cachedTokens = getCachedTokenCount(usage);
  const cacheRate =
    typeof cachedTokens === "number" && usage.prompt_tokens
      ? `${Math.round((cachedTokens / usage.prompt_tokens) * 100)}%`
      : undefined;

  console.info("[BYOK Agent] AI token usage:", {
    provider,
    promptTokens: usage.prompt_tokens,
    cachedPromptTokens: cachedTokens,
    promptCacheHitRate: cacheRate,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens
  });
}

function getCachedTokenCount(usage: ChatUsage): number | undefined {
  const candidates = [
    usage.prompt_tokens_details?.cached_tokens,
    usage.input_tokens_details?.cached_tokens,
    usage.input_tokens_details?.cache_read
  ];

  return candidates.find((value): value is number => typeof value === "number");
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
