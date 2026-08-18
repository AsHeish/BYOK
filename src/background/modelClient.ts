import type {
  AgentAction,
  AgentModelResponse,
  AgentRequirementItemUpdate,
  AgentRequirementProposal,
  AgentRequirementUpdate,
  AgentSettings,
  ModelUsageEvent,
  RequirementStatus,
  RiskLevel,
  WaitCondition,
} from "../shared/types";

const MAX_ACTIONS_PER_MODEL_RESPONSE = 10;
const MAX_TIMEOUT_ATTEMPTS = 4;
const MAX_PROVIDER_COMPATIBILITY_RETRIES = 2;
const MAX_TOTAL_MODEL_REQUEST_ATTEMPTS = MAX_TIMEOUT_ATTEMPTS + MAX_PROVIDER_COMPATIBILITY_RETRIES;
const MIN_REQUEST_TIMEOUT_SECONDS = 10;
const MAX_REQUEST_TIMEOUT_SECONDS = 300;
const AUTOMATIC_PREFIX_CACHE_MODELS = new Set(["qwen-3.6-27b", "gemma-4-31b"]);

type PromptCacheStrategy = "none" | "openai" | "automatic-prefix";

export type ChatMessageContent = string | Array<
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } }
>;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: ChatMessageContent;
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
  cached_tokens?: number;
  cached_prompt_tokens?: number;
  num_cached_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_read_tokens?: number;
    prefix_cached_tokens?: number;
  };
  input_tokens_details?: {
    cached_tokens?: number;
    cache_read?: number;
  };
}

export class ModelClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly usage?: ModelUsageEvent
  ) {
    super(message);
    this.name = "ModelClientError";
  }
}

export class ModelRequestCancelledError extends ModelClientError {
  constructor() {
    super("The model request was stopped.");
    this.name = "ModelRequestCancelledError";
  }
}

export interface ModelRequestNotice {
  kind: "timeout-retry" | "prompt-cache-retry" | "response-format-retry";
  attempt: number;
  maxAttempts: number;
  message: string;
}

export async function requestAgentStep(
  settings: AgentSettings,
  messages: ChatMessage[],
  onNotice?: (notice: ModelRequestNotice) => void,
  signal?: AbortSignal,
): Promise<{ response: AgentModelResponse; usage: ModelUsageEvent }> {
  const endpoint = buildChatCompletionsUrl(settings.apiBaseUrl);
  const requestTimeoutMs = getRequestTimeoutMs(settings);
  const requestStartedAt = Date.now();
  let attempts = 0;
  let timeoutAttempts = 0;

  let includeResponseFormat = true;
  let promptCacheStrategy = getPromptCacheStrategy(settings);
  let result: { response: Response; responseText: string } | undefined;

  for (let attempt = 0; attempt < MAX_TOTAL_MODEL_REQUEST_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) {
      throw new ModelRequestCancelledError();
    }

    attempts = attempt + 1;
    const controller = new AbortController();
    const cancelRequest = () => controller.abort();
    signal?.addEventListener("abort", cancelRequest, { once: true });
    const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      result = await postChatCompletion({
        endpoint,
        settings,
        messages,
        signal: controller.signal,
        includeResponseFormat,
        promptCacheStrategy
      });
      if (signal?.aborted) {
        throw new ModelRequestCancelledError();
      }
    } catch (error) {
      if (error instanceof ModelRequestCancelledError || signal?.aborted) {
        throw new ModelRequestCancelledError();
      }

      if (isAbortError(error)) {
        timeoutAttempts += 1;
        const willRetry = timeoutAttempts < MAX_TIMEOUT_ATTEMPTS;
        const timeoutSeconds = Math.round(requestTimeoutMs / 1000);

        if (willRetry) {
          onNotice?.({
            kind: "timeout-retry",
            attempt: timeoutAttempts,
            maxAttempts: MAX_TIMEOUT_ATTEMPTS,
            message: `The model did not respond within ${timeoutSeconds}s on attempt ${timeoutAttempts} of ${MAX_TIMEOUT_ATTEMPTS}. Retrying the same step now.`
          });
          continue;
        }

        logAiResponseTiming(settings, requestStartedAt, attempts, "timeout", false);
        const timeoutUsage = buildUsageEvent(settings, undefined, requestStartedAt, attempts, "timeout", false);
        throw new ModelClientError(
          `The model request timed out after ${timeoutSeconds} seconds on all ${MAX_TIMEOUT_ATTEMPTS} attempts. Try a longer request timeout or a faster model in Settings.`,
          undefined,
          timeoutUsage
        );
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", cancelRequest);
    }

    if (result.response.ok) {
      break;
    }

    if (promptCacheStrategy !== "none" && shouldRetryWithoutPromptCacheFields(result.response.status, result.responseText)) {
      promptCacheStrategy = "none";
      onNotice?.({
        kind: "prompt-cache-retry",
        attempt: attempts,
        maxAttempts: MAX_TOTAL_MODEL_REQUEST_ATTEMPTS,
        message: "The provider rejected the prompt cache fields. Retrying this step without prompt caching."
      });
      continue;
    }

    if (includeResponseFormat && shouldRetryWithoutResponseFormat(result.response.status, result.responseText)) {
      includeResponseFormat = false;
      onNotice?.({
        kind: "response-format-retry",
        attempt: attempts,
        maxAttempts: MAX_TOTAL_MODEL_REQUEST_ATTEMPTS,
        message: "The provider rejected JSON response format. Retrying this step without it."
      });
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
    throw new ModelClientError(
      formatHttpError(response.status, responseText),
      response.status,
      buildUsageEvent(settings, undefined, requestStartedAt, attempts, response.status, false)
    );
  }

  let data: OpenAiChatCompletionResponse;
  try {
    data = JSON.parse(responseText) as OpenAiChatCompletionResponse;
  } catch {
    throw new ModelClientError(
      "The model provider returned a non-JSON HTTP response.",
      undefined,
      buildUsageEvent(settings, undefined, requestStartedAt, attempts, response.status, false)
    );
  }

  const usage = buildUsageEvent(settings, data.usage, requestStartedAt, attempts, response.status, true);
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new ModelClientError(data.error?.message || "The model response did not include content.", undefined, usage);
  }

  logTokenUsage(settings, data.usage, promptCacheStrategy);
  return {
    response: parseAgentJson(content, usage),
    usage
  };
}

export async function testModelConnection(
  settings: AgentSettings,
  signal?: AbortSignal,
): Promise<{ ok: true; latencyMs: number }> {
  if (!settings.apiKey.trim()) {
    throw new ModelClientError("API key is required.");
  }
  if (!settings.model.trim()) {
    throw new ModelClientError("Model name is required.");
  }

  const endpoint = buildChatCompletionsUrl(settings.apiBaseUrl);
  const requestTimeoutMs = getRequestTimeoutMs(settings);
  const startedAt = Date.now();
  const controller = new AbortController();
  const cancelRequest = () => controller.abort();
  signal?.addEventListener("abort", cancelRequest, { once: true });
  const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const result = await postChatCompletion({
      endpoint,
      settings,
      messages: [{ role: "user", content: "Reply with OK." }],
      signal: controller.signal,
      includeResponseFormat: false,
      promptCacheStrategy: "none",
    });
    if (signal?.aborted) {
      throw new ModelRequestCancelledError();
    }
    if (!result.response.ok) {
      throw new ModelClientError(
        formatHttpError(result.response.status, result.responseText),
        result.response.status,
      );
    }

    let data: OpenAiChatCompletionResponse;
    try {
      data = JSON.parse(result.responseText) as OpenAiChatCompletionResponse;
    } catch {
      throw new ModelClientError("The model provider returned a non-JSON HTTP response.");
    }
    if (!data.choices?.length) {
      throw new ModelClientError(data.error?.message || "The model response did not include a choice.");
    }

    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    if (error instanceof ModelRequestCancelledError || signal?.aborted) {
      throw new ModelRequestCancelledError();
    }
    if (isAbortError(error)) {
      throw new ModelClientError(
        `The connection test timed out after ${Math.round(requestTimeoutMs / 1000)} seconds.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", cancelRequest);
  }
}

async function postChatCompletion(args: {
  endpoint: string;
  settings: AgentSettings;
  messages: ChatMessage[];
  signal: AbortSignal;
  includeResponseFormat: boolean;
  promptCacheStrategy: PromptCacheStrategy;
}): Promise<{ response: Response; responseText: string }> {
  const body: Record<string, unknown> = {
    model: args.settings.model,
    messages: args.messages,
    temperature: 0.2
  };

  if (args.promptCacheStrategy === "openai") {
    body.prompt_cache_key = buildPromptCacheKey(args.settings, args.messages);
    body.prompt_cache_retention = "in_memory";
  } else if (args.promptCacheStrategy === "automatic-prefix") {
    body.cache_salt = buildPromptCacheKey(args.settings, args.messages);
  }

  if (args.includeResponseFormat) {
    body.response_format = { type: "json_object" };
  }

  logAiRequestPayload({
    endpoint: args.endpoint,
    provider: args.settings.provider,
    promptCacheMode: args.settings.promptCacheMode || "auto",
    body,
    messages: args.messages,
    promptCacheStrategy: args.promptCacheStrategy,
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
  promptCacheMode: AgentSettings["promptCacheMode"];
  body: Record<string, unknown>;
  messages: ChatMessage[];
  promptCacheStrategy: PromptCacheStrategy;
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
    body: {
      ...args.body,
      messages: sanitizeMessagesForLogging(args.messages),
    }
  };

  console.groupCollapsed(
    `[BYOK Agent] Full AI request payload (${args.provider}, response_format=${
      args.includeResponseFormat ? "on" : "off"
    }, prompt_cache=${args.promptCacheStrategy}, cache_mode=${args.promptCacheMode})`
  );
  console.info(
    "Prompt cache plan:",
    buildPromptCacheDebugInfo(
      args.messages,
      args.body.prompt_cache_key || args.body.cache_salt,
      args.promptCacheMode,
      args.promptCacheStrategy
    )
  );
  console.info(payload);
  console.info("Request body JSON:", JSON.stringify(args.body, null, 2));
  console.groupEnd();
}

function shouldRetryWithoutResponseFormat(status: number, body: string): boolean {
  return (status === 400 || status === 422) && /response[\s_-]*format|json[\s_-]*object/i.test(body);
}

function shouldRetryWithoutPromptCacheFields(status: number, body: string): boolean {
  return (status === 400 || status === 422) && /prompt_cache_key|prompt_cache_retention|cache_salt|prompt cache|prompt caching|prefix cach/i.test(body);
}

function getRequestTimeoutMs(settings: AgentSettings): number {
  const seconds = Math.min(
    Math.max(Number(settings.requestTimeoutSeconds || 60), MIN_REQUEST_TIMEOUT_SECONDS),
    MAX_REQUEST_TIMEOUT_SECONDS
  );
  return seconds * 1000;
}

function getPromptCacheStrategy(settings: AgentSettings): PromptCacheStrategy {
  const mode = settings.promptCacheMode || "auto";
  if (mode === "off") {
    return "none";
  }
  if (isAutomaticPrefixCacheModel(settings.model)) {
    return "automatic-prefix";
  }
  if (mode === "on") {
    return "openai";
  }
  return settings.provider === "openai" || settings.provider === "custom" ? "openai" : "none";
}

function isAutomaticPrefixCacheModel(model: string): boolean {
  return AUTOMATIC_PREFIX_CACHE_MODELS.has(model.trim().toLowerCase());
}

function buildPromptCacheKey(settings: AgentSettings, messages: ChatMessage[]): string {
  const staticInstructions = getStaticInstructionPrefix(messages);
  const keyMaterial = [settings.apiBaseUrl, settings.model, staticInstructions].join("\n");
  return `byok-agent-${shortHash(keyMaterial)}`;
}

function buildPromptCacheDebugInfo(
  messages: ChatMessage[],
  promptCacheKey: unknown,
  promptCacheMode: AgentSettings["promptCacheMode"],
  strategy: PromptCacheStrategy
): Record<string, unknown> {
  const stablePrefix = getStablePromptPrefix(messages);
  const staticInstructions = getStaticInstructionPrefix(messages);
  return {
    mode: promptCacheMode,
    strategy,
    active: strategy !== "none",
    providerCacheKey: typeof promptCacheKey === "string" ? promptCacheKey : undefined,
    staticInstructionCharacters: staticInstructions.length,
    estimatedStaticInstructionTokens: Math.ceil(staticInstructions.length / 4),
    stablePrefixMessages: Math.min(messages.length, 2),
    stablePrefixCharacters: stablePrefix.length,
    estimatedStablePrefixTokens: Math.ceil(stablePrefix.length / 4),
    note:
      strategy === "automatic-prefix"
        ? "This model uses server-side automatic KV prefix caching. cache_salt keeps requests on the same cache partition, but the inference server must enable prefix caching."
        : "The cache key is shared across tasks with identical system instructions. Static instructions and task remain before changing page observations so provider-side prefix caches can reuse the longest exact match."
  };
}

function getStaticInstructionPrefix(messages: ChatMessage[]): string {
  const systemMessage = messages.find((message) => message.role === "system");
  return systemMessage ? `${systemMessage.role}:\n${getMessageText(systemMessage.content)}` : "";
}

function getStablePromptPrefix(messages: ChatMessage[]): string {
  return messages
    .slice(0, 2)
    .map((message) => `${message.role}:\n${getMessageText(message.content)}`)
    .join("\n\n");
}

export function sanitizeMessagesForLogging(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    ...message,
    content: typeof message.content === "string"
      ? message.content
      : message.content.map((part) => part.type === "image_url"
        ? { ...part, image_url: { ...part.image_url, url: "[image redacted]" } }
        : part),
  }));
}

function getMessageText(content: ChatMessageContent): string {
  return typeof content === "string"
    ? content
    : content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function logTokenUsage(
  settings: AgentSettings,
  usage: ChatUsage | undefined,
  promptCacheStrategy: PromptCacheStrategy
): void {
  if (!usage) {
    return;
  }

  const cachedTokens = getCachedTokenCount(usage);
  const cacheRate =
    typeof cachedTokens === "number" && usage.prompt_tokens
      ? `${Math.round((cachedTokens / usage.prompt_tokens) * 100)}%`
      : undefined;

  console.info("[BYOK Agent] AI token usage:", {
    provider: settings.provider,
    model: settings.model,
    promptCacheStrategy,
    cacheTelemetryAvailable: typeof cachedTokens === "number",
    promptTokens: usage.prompt_tokens,
    cachedPromptTokens: cachedTokens,
    promptCacheHitRate: cacheRate,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens
  });

  if (promptCacheStrategy === "automatic-prefix" && typeof cachedTokens !== "number") {
    console.info(
      "[BYOK Agent] The gateway did not return cached-token telemetry. Verify automatic prefix cache hits in the inference-server metrics or time-to-first-token logs."
    );
  }
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
    usage.prompt_tokens_details?.cache_read_tokens,
    usage.prompt_tokens_details?.prefix_cached_tokens,
    usage.input_tokens_details?.cached_tokens,
    usage.input_tokens_details?.cache_read,
    usage.cached_tokens,
    usage.cached_prompt_tokens,
    usage.num_cached_tokens
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

function buildUsageEvent(
  settings: AgentSettings,
  usage: ChatUsage | undefined,
  startedAt: number,
  attempts: number,
  status: number | "timeout",
  ok: boolean
): ModelUsageEvent {
  return {
    provider: settings.provider,
    model: settings.model,
    promptTokens: usage?.prompt_tokens,
    cachedPromptTokens: usage ? getCachedTokenCount(usage) : undefined,
    completionTokens: usage?.completion_tokens,
    totalTokens: usage?.total_tokens,
    elapsedMs: Date.now() - startedAt,
    attempts,
    status,
    ok,
    timestamp: Date.now()
  };
}

function parseAgentJson(content: string, usage: ModelUsageEvent): AgentModelResponse {
  const jsonText = extractJsonObject(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new ModelClientError("The model did not return strict JSON.", undefined, usage);
  }

  const normalized = normalizeAgentModelResponse(parsed);
  if (!normalized) {
    console.warn("[BYOK Agent] Model JSON did not match the action schema.", {
      parsed,
      rawContent: content
    });
    throw new ModelClientError("The model JSON did not match the required action schema.", undefined, usage);
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
    mode: normalizeAgentResponseMode(value.mode),
    thought_summary: getString(value.thought_summary) || getString(value.thought) || getString(value.summary) || "Next browser action.",
    risk_level: normalizeRiskLevel(value.risk_level),
    actions,
    requirements: normalizeRequirementProposals(value.requirements),
    requirementUpdates: normalizeRequirementUpdates(value.requirementUpdates || value.requirement_updates),
  };
}

function normalizeAgentResponseMode(value: unknown): AgentModelResponse["mode"] {
  return getString(value)?.trim().toLowerCase() === "chat" ? "chat" : "browser";
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
    fileId: getString(value.fileId) || getString(value.file_id) || getString(value.stagedFileId) || getString(value.staged_file_id),
    downloadId: getNumber(value.downloadId) || getNumber(value.download_id),
    maxItems: getNumber(value.maxItems) || getNumber(value.max_items) || getNumber(value.limit),
    text: getString(value.text) || getString(value.value) || getString(value.answer),
    key: normalizeKey(value.key) || normalizeKey(value.text),
    url: getString(value.url),
    tabAlias: getString(value.tabAlias) || getString(value.tab_alias) || getString(value.alias) || getString(value.tab),
    direction: normalizeDirection(value.direction),
    outcome: normalizeOutcome(value.outcome),
    waitCondition: normalizeWaitCondition(value.waitCondition || value.wait_condition || value.condition),
    timeoutMs: getNumber(value.timeoutMs) || getNumber(value.timeout_ms),
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
    upload_file: "upload_file",
    upload: "upload_file",
    file_upload: "upload_file",
    attach_file: "upload_file",
    fill: "fill",
    type: "type",
    select: "select",
    press_key: "press_key",
    key: "press_key",
    summarize_page: "summarize_page",
    page_summary: "summarize_page",
    summarize_webpage: "summarize_page",
    summarize_web_page: "summarize_page",
    read_page: "read_page",
    read_full_page: "read_page",
    get_page_content: "read_page",
    inspect_screenshot: "inspect_screenshot",
    capture_screenshot: "inspect_screenshot",
    screenshot: "inspect_screenshot",
    summarize_pdf: "summarize_pdf",
    pdf_summary: "summarize_pdf",
    list_downloads: "list_downloads",
    downloads: "list_downloads",
    recent_downloads: "list_downloads",
    scroll: "scroll",
    navigate: "navigate",
    open_url: "navigate",
    go_back: "go_back",
    back: "go_back",
    browser_back: "go_back",
    history_back: "go_back",
    previous_page: "go_back",
    go_forward: "go_forward",
    forward: "go_forward",
    browser_forward: "go_forward",
    history_forward: "go_forward",
    reload: "reload",
    refresh: "reload",
    refresh_tab: "reload",
    reload_tab: "reload",
    open_tab: "open_tab",
    new_tab: "open_tab",
    open_new_tab: "open_tab",
    switch_tab: "switch_tab",
    activate_tab: "switch_tab",
    select_tab: "switch_tab",
    close_tab: "close_tab",
    wait_for: "wait_for",
    wait_until: "wait_for",
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

function normalizeOutcome(value: unknown): AgentAction["outcome"] | undefined {
  return value === "completed" || value === "partial" ? value : undefined;
}

function normalizeRequirementProposals(value: unknown): AgentRequirementProposal[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const proposals = value
    .map((item): AgentRequirementProposal | undefined => {
      if (!isRecord(item)) {
        return undefined;
      }
      const text = getString(item.text) || getString(item.requirement) || getString(item.label);
      if (!text) {
        return undefined;
      }
      const labels = normalizeItemProposals(item.items);
      return {
        text,
        expectedItemCount: getNumber(item.expectedItemCount) || getNumber(item.expected_item_count),
        items: labels,
      };
    })
    .filter((item): item is AgentRequirementProposal => Boolean(item))
    .slice(0, 50);

  return proposals.length ? proposals : undefined;
}

function normalizeRequirementUpdates(value: unknown): AgentRequirementUpdate[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const updates = value
    .map((item): AgentRequirementUpdate | undefined => {
      if (!isRecord(item)) {
        return undefined;
      }
      const requirementId = getString(item.requirementId) || getString(item.requirement_id) || getString(item.id);
      if (!requirementId) {
        return undefined;
      }
      return {
        requirementId,
        status: normalizeRequirementStatus(item.status),
        evidenceIds: getStringArray(item.evidenceIds) || getStringArray(item.evidence_ids),
        blockedReason: getString(item.blockedReason) || getString(item.blocked_reason) || getString(item.reason),
        expectedItemCount: getNumber(item.expectedItemCount) || getNumber(item.expected_item_count),
        addItems: normalizeItemProposals(item.addItems || item.add_items),
        itemUpdates: normalizeRequirementItemUpdates(item.itemUpdates || item.item_updates),
      };
    })
    .filter((item): item is AgentRequirementUpdate => Boolean(item))
    .slice(0, 100);

  return updates.length ? updates : undefined;
}

function normalizeItemProposals(value: unknown): Array<{ label: string }> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map((item) => isRecord(item) ? getString(item.label) || getString(item.text) : getString(item))
    .filter((label): label is string => Boolean(label))
    .slice(0, 200)
    .map((label) => ({ label }));
  return items.length ? items : undefined;
}

function normalizeRequirementItemUpdates(value: unknown): AgentRequirementUpdate["itemUpdates"] {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const updates = value
    .map((item): AgentRequirementItemUpdate | undefined => {
      if (!isRecord(item)) {
        return undefined;
      }
      const itemId = getString(item.itemId) || getString(item.item_id) || getString(item.id);
      const status = normalizeRequirementStatus(item.status);
      if (!itemId || !status) {
        return undefined;
      }
      return {
        itemId,
        status,
        evidenceIds: getStringArray(item.evidenceIds) || getStringArray(item.evidence_ids),
        blockedReason: getString(item.blockedReason) || getString(item.blocked_reason) || getString(item.reason),
      };
    })
    .filter((item): item is AgentRequirementItemUpdate => Boolean(item))
    .slice(0, 300);
  return updates.length ? updates : undefined;
}

function normalizeRequirementStatus(value: unknown): RequirementStatus | undefined {
  return value === "pending" || value === "satisfied" || value === "blocked" ? value : undefined;
}

function normalizeWaitCondition(value: unknown): WaitCondition | undefined {
  const allowed: WaitCondition[] = [
    "document_ready",
    "dom_stable",
    "url_changed",
    "text_present",
    "text_absent",
    "element_hidden",
    "element_enabled",
  ];
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_") as WaitCondition;
  return allowed.includes(normalized) ? normalized : undefined;
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

function getNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : undefined;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
