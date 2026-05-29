import { DEFAULT_SETTINGS } from "./defaults";
import type { AgentSettings, Provider } from "./types";

const SETTINGS_KEY = "byokAgentSettings";
const TASK_DRAFT_KEY = "byokAgentTaskDraft";

function normalizeProvider(value: unknown): Provider {
  if (value === "openai" || value === "gemini" || value === "groq" || value === "custom") {
    return value;
  }
  return DEFAULT_SETTINGS.provider;
}

export async function loadSettings(): Promise<AgentSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = stored[SETTINGS_KEY] as Partial<AgentSettings> | undefined;

  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    provider: normalizeProvider(raw?.provider),
    apiBaseUrl: String(raw?.apiBaseUrl || DEFAULT_SETTINGS.apiBaseUrl).replace(/\/+$/, ""),
    apiKey: String(raw?.apiKey || ""),
    model: String(raw?.model || DEFAULT_SETTINGS.model),
    maxSteps: Math.min(Math.max(Number(raw?.maxSteps || DEFAULT_SETTINGS.maxSteps), 1), 30),
    theme: raw?.theme === "light" || raw?.theme === "dark" ? raw.theme : DEFAULT_SETTINGS.theme
  };
}

export async function saveSettings(settings: AgentSettings): Promise<void> {
  // chrome.storage.local is profile-local extension storage. It is not a secure vault.
  // Users should prefer scoped, revocable BYOK keys and browser profile protections.
  await chrome.storage.local.set({
    [SETTINGS_KEY]: {
      ...settings,
      apiBaseUrl: settings.apiBaseUrl.replace(/\/+$/, ""),
      maxSteps: Math.min(Math.max(settings.maxSteps, 1), 30)
    }
  });
}

export async function loadTaskDraft(): Promise<string> {
  const stored = await chrome.storage.local.get(TASK_DRAFT_KEY);
  return String(stored[TASK_DRAFT_KEY] || "");
}

export async function saveTaskDraft(task: string): Promise<void> {
  await chrome.storage.local.set({
    [TASK_DRAFT_KEY]: task
  });
}
