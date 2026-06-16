import type { AgentSettings } from "./types";

export const DEFAULT_SETTINGS: AgentSettings = {
  provider: "openai",
  apiBaseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o-mini",
  maxSteps: 60,
  requestTimeoutSeconds: 60,
  promptCacheMode: "auto",
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

export const MAX_PAGE_TEXT_CHARS = 10000;
export const MAX_DOM_ELEMENTS = 80;
export const MAX_LOG_ENTRIES = 80;
