import { DEFAULT_SETTINGS } from "./defaults";
import type { AgentSettings, AiConfigurationProfile, PromptCacheMode, Provider } from "./types";

const SETTINGS_KEY = "byokAgentSettings";
const TASK_DRAFT_KEY = "byokAgentTaskDraft";
const CONFIG_PROFILES_KEY = "byokAgentConfigProfiles";
const MIN_MAX_STEPS = 1;
const MAX_MAX_STEPS = 60;
const LEGACY_DEFAULT_MAX_STEPS = new Set([12, 30]);
const MIN_REQUEST_TIMEOUT_SECONDS = 10;
const MAX_REQUEST_TIMEOUT_SECONDS = 300;

function normalizeProvider(value: unknown): Provider {
  if (
    value === "openai" ||
    value === "gemini" ||
    value === "groq" ||
    value === "custom"
  ) {
    return value;
  }
  return DEFAULT_SETTINGS.provider;
}

function normalizePromptCacheMode(value: unknown): PromptCacheMode {
  if (value === "auto" || value === "on" || value === "off") {
    return value;
  }
  return DEFAULT_SETTINGS.promptCacheMode;
}

function normalizeOptionalPrice(value: unknown): number | undefined {
  if (value === "" || value === null || typeof value === "undefined") {
    return undefined;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : undefined;
}

function clampMaxSteps(value: unknown): number {
  const numericValue = Number(value || DEFAULT_SETTINGS.maxSteps);
  return Math.min(Math.max(numericValue, MIN_MAX_STEPS), MAX_MAX_STEPS);
}

function normalizeStoredMaxSteps(value: unknown): number {
  const numericValue = Number(value || DEFAULT_SETTINGS.maxSteps);
  return LEGACY_DEFAULT_MAX_STEPS.has(numericValue)
    ? DEFAULT_SETTINGS.maxSteps
    : clampMaxSteps(numericValue);
}

export async function loadSettings(): Promise<AgentSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = stored[SETTINGS_KEY] as Partial<AgentSettings> | undefined;

  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    provider: normalizeProvider(raw?.provider),
    apiBaseUrl: String(raw?.apiBaseUrl || DEFAULT_SETTINGS.apiBaseUrl).replace(
      /\/+$/,
      "",
    ),
    apiKey: String(raw?.apiKey || ""),
    model: String(raw?.model || DEFAULT_SETTINGS.model),
    maxSteps: normalizeStoredMaxSteps(raw?.maxSteps),
    requestTimeoutSeconds: Math.min(
      Math.max(
        Number(raw?.requestTimeoutSeconds || DEFAULT_SETTINGS.requestTimeoutSeconds),
        MIN_REQUEST_TIMEOUT_SECONDS,
      ),
      MAX_REQUEST_TIMEOUT_SECONDS,
    ),
    promptCacheMode: normalizePromptCacheMode(raw?.promptCacheMode),
    inputTokenCostPerMillion: normalizeOptionalPrice(raw?.inputTokenCostPerMillion),
    cachedInputTokenCostPerMillion: normalizeOptionalPrice(raw?.cachedInputTokenCostPerMillion),
    outputTokenCostPerMillion: normalizeOptionalPrice(raw?.outputTokenCostPerMillion),
    theme:
      raw?.theme === "light" || raw?.theme === "dark"
        ? raw.theme
        : DEFAULT_SETTINGS.theme,
  };
}

export async function saveSettings(settings: AgentSettings): Promise<void> {
  // chrome.storage.local is profile-local extension storage. It is not a secure vault.
  // Users should prefer scoped, revocable BYOK keys and browser profile protections.
  await chrome.storage.local.set({
    [SETTINGS_KEY]: {
      ...settings,
      apiBaseUrl: settings.apiBaseUrl.replace(/\/+$/, ""),
      maxSteps: clampMaxSteps(settings.maxSteps),
      requestTimeoutSeconds: Math.min(
        Math.max(settings.requestTimeoutSeconds, MIN_REQUEST_TIMEOUT_SECONDS),
        MAX_REQUEST_TIMEOUT_SECONDS,
      ),
      promptCacheMode: normalizePromptCacheMode(settings.promptCacheMode),
      inputTokenCostPerMillion: normalizeOptionalPrice(settings.inputTokenCostPerMillion),
      cachedInputTokenCostPerMillion: normalizeOptionalPrice(settings.cachedInputTokenCostPerMillion),
      outputTokenCostPerMillion: normalizeOptionalPrice(settings.outputTokenCostPerMillion),
    },
  });
}

export async function loadTaskDraft(): Promise<string> {
  const stored = await chrome.storage.local.get(TASK_DRAFT_KEY);
  return String(stored[TASK_DRAFT_KEY] || "");
}

export async function saveTaskDraft(task: string): Promise<void> {
  await chrome.storage.local.set({
    [TASK_DRAFT_KEY]: task,
  });
}

export async function loadConfigurationProfiles(): Promise<
  AiConfigurationProfile[]
> {
  const stored = await chrome.storage.local.get(CONFIG_PROFILES_KEY);
  return normalizeProfiles(stored[CONFIG_PROFILES_KEY]);
}

export async function saveConfigurationProfile(
  name: string,
  settings: AgentSettings,
): Promise<AiConfigurationProfile[]> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error("Profile name is required.");
  }

  const profiles = await loadConfigurationProfiles();
  const now = Date.now();
  const existing = profiles.find(
    (profile) => profile.name.toLowerCase() === trimmedName.toLowerCase(),
  );
  const savedProfile: AiConfigurationProfile = {
    id: existing?.id || createProfileId(),
    name: trimmedName,
    provider: settings.provider,
    apiBaseUrl: settings.apiBaseUrl.replace(/\/+$/, ""),
    apiKey: settings.apiKey,
    model: settings.model,
    maxSteps: clampMaxSteps(settings.maxSteps),
    requestTimeoutSeconds: Math.min(
      Math.max(settings.requestTimeoutSeconds, MIN_REQUEST_TIMEOUT_SECONDS),
      MAX_REQUEST_TIMEOUT_SECONDS,
    ),
    promptCacheMode: normalizePromptCacheMode(settings.promptCacheMode),
    inputTokenCostPerMillion: normalizeOptionalPrice(settings.inputTokenCostPerMillion),
    cachedInputTokenCostPerMillion: normalizeOptionalPrice(settings.cachedInputTokenCostPerMillion),
    outputTokenCostPerMillion: normalizeOptionalPrice(settings.outputTokenCostPerMillion),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  const nextProfiles = existing
    ? profiles.map((profile) =>
        profile.id === existing.id ? savedProfile : profile,
      )
    : [...profiles, savedProfile];

  await chrome.storage.local.set({
    [CONFIG_PROFILES_KEY]: nextProfiles,
  });
  return nextProfiles;
}

export async function deleteConfigurationProfile(
  profileId: string,
): Promise<AiConfigurationProfile[]> {
  const profiles = await loadConfigurationProfiles();
  const nextProfiles = profiles.filter((profile) => profile.id !== profileId);
  await chrome.storage.local.set({
    [CONFIG_PROFILES_KEY]: nextProfiles,
  });
  return nextProfiles;
}

export function applyConfigurationProfile(
  settings: AgentSettings,
  profile: AiConfigurationProfile,
): AgentSettings {
  return {
    ...settings,
    provider: profile.provider,
    apiBaseUrl: profile.apiBaseUrl,
    apiKey: profile.apiKey,
    model: profile.model,
    maxSteps: profile.maxSteps,
    requestTimeoutSeconds: profile.requestTimeoutSeconds,
    promptCacheMode: profile.promptCacheMode,
    inputTokenCostPerMillion: profile.inputTokenCostPerMillion,
    cachedInputTokenCostPerMillion: profile.cachedInputTokenCostPerMillion,
    outputTokenCostPerMillion: profile.outputTokenCostPerMillion,
  };
}

function normalizeProfiles(value: unknown): AiConfigurationProfile[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((profile): AiConfigurationProfile | undefined => {
      if (!profile || typeof profile !== "object") {
        return undefined;
      }

      const raw = profile as Partial<AiConfigurationProfile>;
      const name = String(raw.name || "").trim();
      if (!name) {
        return undefined;
      }

      return {
        id: String(raw.id || createProfileId()),
        name,
        provider: normalizeProvider(raw.provider),
        apiBaseUrl: String(
          raw.apiBaseUrl || DEFAULT_SETTINGS.apiBaseUrl,
        ).replace(/\/+$/, ""),
        apiKey: String(raw.apiKey || ""),
        model: String(raw.model || DEFAULT_SETTINGS.model),
        maxSteps: normalizeStoredMaxSteps(raw.maxSteps),
        requestTimeoutSeconds: Math.min(
          Math.max(
            Number(raw.requestTimeoutSeconds || DEFAULT_SETTINGS.requestTimeoutSeconds),
            MIN_REQUEST_TIMEOUT_SECONDS,
          ),
          MAX_REQUEST_TIMEOUT_SECONDS,
        ),
        promptCacheMode: normalizePromptCacheMode(raw.promptCacheMode),
        inputTokenCostPerMillion: normalizeOptionalPrice(raw.inputTokenCostPerMillion),
        cachedInputTokenCostPerMillion: normalizeOptionalPrice(raw.cachedInputTokenCostPerMillion),
        outputTokenCostPerMillion: normalizeOptionalPrice(raw.outputTokenCostPerMillion),
        createdAt: Number(raw.createdAt || Date.now()),
        updatedAt: Number(raw.updatedAt || Date.now()),
      };
    })
    .filter((profile): profile is AiConfigurationProfile => Boolean(profile))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function createProfileId(): string {
  return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
