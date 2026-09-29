import type { AgentSettings, OpenAiApi } from "./types";

export const MIN_REQUEST_TIMEOUT_SECONDS = 10;
export const MAX_REQUEST_TIMEOUT_SECONDS = 300;
export const JEV_MODEL = "jev-1.13.0";

export const DEFAULT_SETTINGS: AgentSettings = {
  provider: "openai",
  apiBaseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  maxSteps: 60,
  requestTimeoutSeconds: 60,
  promptCacheMode: "auto",
  disableThinking: false,
  jev: { mode: "off", apiKey: "" },
  saveRunHistory: true,
  theme: "dark"
};

export const PROVIDER_DEFAULT_BASE_URLS = {
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  groq: "https://api.groq.com/openai/v1",
  custom: ""
} as const;

export const PROVIDER_DEFAULT_MODELS = {
  openai: "gpt-4o-mini",
  gemini: "gemini-2.0-flash",
  groq: "llama-3.3-70b-versatile",
  custom: ""
} as const;

// OpenAI's explicit choice wins; otherwise an explicit URL path, then api.openai.com -> Responses.
export function resolveModelApi(settings: Pick<AgentSettings, "provider" | "apiBaseUrl" | "openAiApi">): OpenAiApi {
  if (settings.provider === "openai" && settings.openAiApi) return settings.openAiApi;
  let url: URL;
  try {
    url = new URL(settings.apiBaseUrl.replace(/\/+$/, ""));
  } catch {
    return "chat";
  }
  if (url.pathname.endsWith("/chat/completions")) return "chat";
  if (url.pathname.endsWith("/responses")) return "responses";
  return url.hostname.toLowerCase() === "api.openai.com" ? "responses" : "chat";
}

export const MAX_PAGE_TEXT_CHARS = 10000;
export const MAX_DOM_ELEMENTS = 80;
export const MAX_LOG_ENTRIES = 80;
export const MAX_CHAT_MESSAGES = 100;
export const MAX_CHAT_SUGGESTIONS = 9;
export const DEFAULT_CHAT_SUGGESTIONS = [
  "Summarize the current page.",
  "Give me the key takeaways from this page.",
  "What can you help me do on this page?",
] as const;
export const MAX_TRACKED_TABS = 8;
