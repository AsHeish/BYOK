import type { AgentAction, AgentModelResponse, AgentSettings, RiskLevel } from "../shared/types";

const MAX_ACTIONS_PER_MODEL_RESPONSE = 10;
const MAX_MODEL_REQUEST_ATTEMPTS = 4;
const MIN_REQUEST_TIMEOUT_SECONDS = 10;
const MAX_REQUEST_TIMEOUT_SECONDS = 300;

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
  const requestTimeoutMs = getRequestTimeoutMs(settings);
  const requestStartedAt = Date.now();
  let attempts = 0;

  let includeResponseFormat = true;
  let includePromptCacheFields = shouldUsePromptCacheFields(settings);
  let result: { response: Response; responseText: string } | undefined;

  for (let attempt = 0; attempt < MAX_MODEL_REQUEST_ATTEMPTS; attempt += 1) {
    attempts = attempt + 1;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      result = await postChatCompletion({
        endpoint,
        settings,
        messages,
        signal: controller.signal,
        includeResponseFormat,
        includePromptCacheFields
      });
    } catch (error) {
      if (isAbortError(error)) {
        const willRetry = attempt < MAX_MODEL_REQUEST_ATTEMPTS - 1;
        console.warn(
          `[BYOK Agent] AI request timed out after ${requestTimeoutMs / 1000}s${
            willRetry ? `; retrying automatically (${attempts + 1}/${MAX_MODEL_REQUEST_ATTEMPTS}).` : "."
          }`
        );

        if (willRetry) {
          continue;
        }

        logAiResponseTiming(settings, requestStartedAt, attempts, "timeout", false);
        throw new ModelClientError(
          `The model request timed out after ${requestTimeoutMs / 1000} seconds and automatic retries were exhausted.`
        );
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

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
  logAiResponseTiming(settings, requestStartedAt, attempts, response.status, response.ok);
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

function getRequestTimeoutMs(settings: AgentSettings): number {
  const seconds = Math.min(
    Math.max(Number(settings.requestTimeoutSeconds || 60), MIN_REQUEST_TIMEOUT_SECONDS),
    MAX_REQUEST_TIMEOUT_SECONDS
  );
  return seconds * 1000;
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

function logAiResponseTiming(
  settings: AgentSettings,
  startedAt: number,
  attempts: number,
  status: number | "timeout",
  ok: boolean
): void {
  console.info("[BYOK Agent] AI response time:", {
    provider: settings.provider,
    model: settings.model,
    elapsedMs: Date.now() - startedAt,
    attempts,
    status,
    ok
  });
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError" ||
    isRecord(error) && error.name === "AbortError"
  );
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

  const normalized = normalizeAgentModelResponse(parsed);
  if (!normalized) {
    console.warn("[BYOK Agent] Model JSON did not match the action schema.", {
      parsed,
      rawContent: content
    });
    throw new ModelClientError("The model JSON did not match the required action schema.");
  }

  return normalized;
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

function normalizeAgentModelResponse(value: unknown): AgentModelResponse | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const rawActions = getRawActions(value);
  const actions = rawActions.flatMap(normalizeAgentAction).slice(0, MAX_ACTIONS_PER_MODEL_RESPONSE);

  if (actions.length === 0) {
    return undefined;
  }

  return {
    thought_summary: getString(value.thought_summary) || getString(value.thought) || getString(value.summary) || "Next browser action.",
    risk_level: normalizeRiskLevel(value.risk_level),
    actions
  };
}

function getRawActions(value: Record<string, unknown>): unknown[] {
  if (Array.isArray(value.actions)) {
    return value.actions;
  }

  if (Array.isArray(value.action)) {
    return value.action;
  }

  if (isRecord(value.actions)) {
    return [value.actions];
  }

  if (isRecord(value.action)) {
    return [value.action];
  }

  if (Array.isArray(value.plan)) {
    return value.plan;
  }

  if (isRecord(value.next_action)) {
    return [value.next_action];
  }

  return [];
}

function normalizeAgentAction(value: unknown): AgentAction[] {
  if (!isRecord(value) || typeof value.type !== "string") {
    return [];
  }

  const type = normalizeActionType(value.type);
  if (!type) {
    return [];
  }

  const elementId = getString(value.elementId) || getString(value.element_id) || getString(value.id);
  const targetElementId =
    getString(value.targetElementId) || getString(value.target_element_id) || getString(value.targetId) || getString(value.target_id);
  const action: AgentAction = {
    type,
    elementId,
    elementIds: getStringArray(value.elementIds) || getStringArray(value.element_ids),
    targetElementId,
    dragPairs: normalizeDragPairs(value.dragPairs) || normalizeDragPairs(value.drag_pairs) || normalizeDragPairs(value.pairs),
    text: getString(value.text) || getString(value.value) || getString(value.answer),
    key: normalizeKey(value.key) || normalizeKey(value.text),
    url: getString(value.url),
    direction: normalizeDirection(value.direction)
  };

  if (action.type === "multi_click" && !action.elementIds?.length && action.elementId) {
    action.elementIds = [action.elementId];
  }

  if (action.type === "multi_drag") {
    if (!action.dragPairs?.length && action.elementId && action.targetElementId) {
      action.dragPairs = [{ elementId: action.elementId, targetElementId: action.targetElementId }];
    }
    action.dragPairs = action.dragPairs?.slice(0, MAX_ACTIONS_PER_MODEL_RESPONSE);
  }

  if (action.type === "multi_click" && !action.elementIds?.length) {
    return [];
  }

  if (action.type === "multi_drag" && !action.dragPairs?.length) {
    return [];
  }

  return [action];
}

function normalizeActionType(type: string): AgentAction["type"] | undefined {
  const normalized = type.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases: Record<string, AgentAction["type"]> = {
    click: "click",
    multi_click: "multi_click",
    multiclick: "multi_click",
    click_many: "multi_click",
    drag: "drag",
    drag_and_drop: "drag",
    multi_drag: "multi_drag",
    multidrag: "multi_drag",
    drag_many: "multi_drag",
    fill: "fill",
    type: "type",
    select: "select",
    press_key: "press_key",
    key: "press_key",
    scroll: "scroll",
    navigate: "navigate",
    open_url: "navigate",
    extract: "extract",
    ask_user: "ask_user",
    ask: "ask_user",
    done: "done"
  };
  return aliases[normalized];
}

function normalizeRiskLevel(value: unknown): RiskLevel {
  const normalized = String(value || "").toLowerCase();
  return normalized === "medium" || normalized === "high" ? normalized : "low";
}

function normalizeKey(value: unknown): AgentAction["key"] | undefined {
  const normalized = String(value || "").trim().toLowerCase().replace(/\s+/g, "");
  if (normalized === "tab") {
    return "Tab";
  }
  if (normalized === "shift+tab" || normalized === "shifttab") {
    return "Shift+Tab";
  }
  return undefined;
}

function normalizeDirection(value: unknown): AgentAction["direction"] | undefined {
  const normalized = String(value || "").toLowerCase();
  return normalized === "up" || normalized === "down" || normalized === "left" || normalized === "right" ? normalized : undefined;
}

function normalizeDragPairs(value: unknown): AgentAction["dragPairs"] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const pairs = value
    .map((pair) => {
      if (!isRecord(pair)) {
        return undefined;
      }

      const elementId = getString(pair.elementId) || getString(pair.element_id) || getString(pair.sourceElementId) || getString(pair.source_id);
      const targetElementId =
        getString(pair.targetElementId) ||
        getString(pair.target_element_id) ||
        getString(pair.destinationElementId) ||
        getString(pair.destination_id) ||
        getString(pair.targetId);

      return elementId && targetElementId ? { elementId, targetElementId } : undefined;
    })
    .filter((pair): pair is { elementId: string; targetElementId: string } => Boolean(pair));

  return pairs.length ? pairs : undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const values = value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
  return values.length ? values : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
