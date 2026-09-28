import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChatMessage, AgentSettings, RunReport } from "./types";
import { DEFAULT_JEV_PROFILE_ID, DEFAULT_JEV_PROFILE_NAME } from "./defaults";
import {
  applyConfigurationProfile,
  clearChatMessages,
  deleteConfigurationProfile,
  importConfigurationProfiles,
  loadChatSuggestions,
  loadChatMessages,
  loadConfigurationProfiles,
  loadRunReports,
  loadSettings,
  markInterruptedRunReports,
  resetChatSuggestions,
  saveChatSuggestions,
  saveChatMessages,
  saveConfigurationProfile,
  saveRunReport,
  saveSettings,
  serializeConfigurationProfiles,
  updateConfigurationProfile,
} from "./storage";

const PROFILE_SETTINGS: AgentSettings = {
  provider: "openai",
  apiBaseUrl: "https://api.example.test/v1/",
  apiKey: "secret-key",
  model: "test-model",
  maxSteps: 20,
  requestTimeoutSeconds: 30,
  promptCacheMode: "auto",
  saveRunHistory: true,
  theme: "dark",
};

let stored: Record<string, unknown>;

beforeEach(() => {
  stored = {};
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (key?: string | string[]) => {
          if (typeof key === "string") {
            return { [key]: stored[key] };
          }
          if (Array.isArray(key)) {
            return Object.fromEntries(key.map((item) => [item, stored[item]]));
          }
          return { ...stored };
        }),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(stored, values);
        }),
        remove: vi.fn(async (key: string) => {
          delete stored[key];
        }),
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("settings persistence", () => {
  it("preserves provider defaults until thinking is explicitly disabled", async () => {
    expect((await loadSettings()).disableThinking).toBe(false);
    await saveSettings({ ...PROFILE_SETTINGS, disableThinking: true });
    expect((await loadSettings()).disableThinking).toBe(true);
    await saveSettings({ ...PROFILE_SETTINGS, disableThinking: false });
    expect((await loadSettings()).disableThinking).toBe(false);
    stored.byokAgentSettings = { ...PROFILE_SETTINGS, disableThinking: "true" };
    expect((await loadSettings()).disableThinking).toBe(false);
  });

  it.each(["", "jev-key"])("preserves Jev Only even when its key is %j", async (apiKey) => {
    await saveSettings({ ...PROFILE_SETTINGS, jev: { mode: "only", apiKey } });
    expect((await loadSettings()).jev).toEqual({ mode: "only", apiKey });
    const profiles = await saveConfigurationProfile("Jev Only", { ...PROFILE_SETTINGS, jev: { mode: "only", apiKey } });
    const imported = await importConfigurationProfiles(JSON.parse(serializeConfigurationProfiles(profiles.filter((profile) => profile.id !== DEFAULT_JEV_PROFILE_ID))));
    const profile = imported.profiles.find((entry) => imported.importedIds.includes(entry.id))!;
    expect(profile.jev).toEqual({ mode: "only", apiKey });
    expect(applyConfigurationProfile(PROFILE_SETTINGS, profile).jev?.mode).toBe("only");
  });

  it("defaults Jev off and round-trips its separate key and mode", async () => {
    expect((await loadSettings()).jev).toEqual({ mode: "off", apiKey: "" });
    await saveSettings({ ...PROFILE_SETTINGS, jev: { mode: "shadow", apiKey: " jev-key " } });
    expect((await loadSettings()).jev).toEqual({ mode: "shadow", apiKey: "jev-key" });
    expect((await loadSettings()).apiKey).toBe(PROFILE_SETTINGS.apiKey);
  });

  it("does not enable Jev for invalid settings or an absent key", async () => {
    stored.byokAgentSettings = { jev: { mode: "unknown", apiKey: "jev-key" } };
    expect((await loadSettings()).jev?.mode).toBe("off");
    await saveSettings({ ...PROFILE_SETTINGS, jev: { mode: "fast", apiKey: "" } });
    expect((await loadSettings()).jev?.mode).toBe("off");
  });

  it("preserves a 60-second model timeout", async () => {
    await saveSettings({ ...PROFILE_SETTINGS, requestTimeoutSeconds: 60 });

    expect((await loadSettings()).requestTimeoutSeconds).toBe(60);
  });
});

describe("run report persistence", () => {
  it("survives reload and marks an unfinished run interrupted", async () => {
    const report: RunReport = {
      id: "task-1",
      task: "Summarize the current page",
      status: "running",
      startUrl: "https://example.com/",
      requirements: [],
      evidence: [],
      findings: [],
      usage: {
        jev: { requests: 2, helperRequests: 1, lastDecision: [{ question: "operation", choice: "click", confidence: 0.99, probabilities: [{ option: "click", probability: 0.99 }] }], fastDecisions: 1, shadowDecisions: 0, fallbacks: 1, inputTokens: 200, outputTokens: 20, totalLatencyMs: 400, estimatedCostUsd: 0.0000084 },
        requestCount: 0,
        successfulRequestCount: 0,
        cacheHitRequestCount: 0,
        promptTokens: 0,
        cachedPromptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        totalLatencyMs: 0,
        costConfigured: false,
      },
      startedAt: 10,
      updatedAt: 10,
    };

    await saveRunReport(report);
    const reloaded = await loadRunReports();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].id).toBe("task-1");
    expect(reloaded[0].status).toBe("running");
    expect(reloaded[0].usage.jev).toEqual(report.usage.jev);

    await markInterruptedRunReports(20);
    const recovered = await loadRunReports();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].status).toBe("interrupted");
    expect(recovered[0].endedAt).toBe(20);
  });
});

describe("chat persistence", () => {
  it("persists a bounded, validated transcript and clears it", async () => {
    const messages: AgentChatMessage[] = Array.from({ length: 102 }, (_, index) => ({
      id: `chat-${index}`,
      role: index % 2 ? "assistant" : "user",
      content: `Message ${index}`,
      kind: index % 2 ? "answer" : "message",
      timestamp: index,
      responseTimeMs: index % 2 ? index * 100 : undefined,
    }));

    await saveChatMessages(messages);
    const reloaded = await loadChatMessages();
    expect(reloaded).toHaveLength(100);
    expect(reloaded[0].id).toBe("chat-2");
    expect(reloaded.at(-1)?.content).toBe("Message 101");
    expect(reloaded.at(-1)?.responseTimeMs).toBe(10_100);

    await clearChatMessages();
    expect(await loadChatMessages()).toEqual([]);
  });
});

describe("chat suggestion persistence", () => {
  it("uses defaults until the user customizes suggestions", async () => {
    expect(await loadChatSuggestions()).toEqual([
      "Summarize the current page.",
      "Give me the key takeaways from this page.",
      "What can you help me do on this page?",
    ]);
  });

  it("normalizes, deduplicates, limits, and preserves an intentionally empty list", async () => {
    const suggestions = [
      "  Summarize   this page  ",
      "summarize this page",
      ...Array.from({ length: 10 }, (_, index) => `Suggestion ${index}`),
    ];
    expect(await saveChatSuggestions(suggestions)).toEqual([
      "Summarize this page",
      ...Array.from({ length: 8 }, (_, index) => `Suggestion ${index}`),
    ]);
    expect(await loadChatSuggestions()).toHaveLength(9);

    await saveChatSuggestions([]);
    expect(await loadChatSuggestions()).toEqual([]);
  });

  it("restores defaults", async () => {
    await saveChatSuggestions(["Custom suggestion"]);
    expect(await resetChatSuggestions()).toHaveLength(3);
    expect(await loadChatSuggestions()).toContain("Summarize the current page.");
  });
});

describe("configuration profile persistence", () => {
  it("round-trips disabled thinking through save, update, import, and apply", async () => {
    const settings: AgentSettings = { ...PROFILE_SETTINGS, disableThinking: true };
    const saved = await saveConfigurationProfile("No thinking", settings);
    const profile = saved.find((entry) => entry.name === "No thinking")!;
    expect(profile.disableThinking).toBe(true);
    const imported = await importConfigurationProfiles(JSON.parse(serializeConfigurationProfiles([profile])));
    const copy = imported.profiles.find((entry) => imported.importedIds.includes(entry.id))!;
    expect(copy.disableThinking).toBe(true);
    expect(applyConfigurationProfile(PROFILE_SETTINGS, copy).disableThinking).toBe(true);
    expect(applyConfigurationProfile(settings, { ...copy, disableThinking: undefined }).disableThinking).toBe(false);
    const updated = await updateConfigurationProfile(profile.id, { ...settings, disableThinking: false });
    expect(updated.find((entry) => entry.id === profile.id)?.disableThinking).toBe(false);
    expect(applyConfigurationProfile(settings, (await loadConfigurationProfiles()).find((entry) => entry.id === DEFAULT_JEV_PROFILE_ID)!).disableThinking).toBe(true);
  });

  it("creates one permanent Jev profile and retains an existing TypeSafe key", async () => {
    await saveSettings({ ...PROFILE_SETTINGS, jev: { mode: "only", apiKey: "existing-jev-key" } });
    const first = await loadConfigurationProfiles();
    const second = await loadConfigurationProfiles();
    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(first[0]).toMatchObject({ id: DEFAULT_JEV_PROFILE_ID, name: DEFAULT_JEV_PROFILE_NAME, apiKey: "", jev: { mode: "only", apiKey: "existing-jev-key" } });
    await expect(deleteConfigurationProfile(DEFAULT_JEV_PROFILE_ID)).rejects.toThrow("cannot be deleted");
    expect(await loadConfigurationProfiles()).toHaveLength(1);
  });

  it("updates and reloads the default Jev config without replacing LLM credentials", async () => {
    const first = (await loadConfigurationProfiles())[0];
    await updateConfigurationProfile(DEFAULT_JEV_PROFILE_ID, { ...PROFILE_SETTINGS, jev: { mode: "only", apiKey: "new-jev-key" } });
    const profile = (await loadConfigurationProfiles()).find((entry) => entry.id === DEFAULT_JEV_PROFILE_ID)!;
    expect(profile).toMatchObject({ id: first.id, name: first.name, createdAt: first.createdAt, apiKey: "", jev: { mode: "only", apiKey: "new-jev-key" } });
    expect(applyConfigurationProfile(PROFILE_SETTINGS, profile)).toEqual({ ...PROFILE_SETTINGS, jev: { mode: "only", apiKey: "new-jev-key" } });
    await expect(updateConfigurationProfile(DEFAULT_JEV_PROFILE_ID, PROFILE_SETTINGS)).rejects.toThrow("Select Jev Only");
  });

  it("exports and imports the Jev config without overwriting the default identity", async () => {
    const profiles = await updateConfigurationProfile(DEFAULT_JEV_PROFILE_ID, { ...PROFILE_SETTINGS, jev: { mode: "only", apiKey: "jev-export-key" } });
    const imported = await importConfigurationProfiles(JSON.parse(serializeConfigurationProfiles(profiles)));
    expect(imported.importedIds).toHaveLength(1);
    expect(imported.importedIds).not.toContain(DEFAULT_JEV_PROFILE_ID);
    expect(imported.profiles.filter((profile) => profile.id === DEFAULT_JEV_PROFILE_ID)).toHaveLength(1);
    expect(imported.profiles.find((profile) => imported.importedIds.includes(profile.id))?.jev).toEqual({ mode: "only", apiKey: "jev-export-key" });
  });

  it("round-trips Jev in profiles and disables it when applying a legacy profile", async () => {
    const settings: AgentSettings = { ...PROFILE_SETTINGS, jev: { mode: "fast", apiKey: "jev-key" } };
    const saved = await saveConfigurationProfile("Jev", settings);
    expect(saved[0].jev).toEqual(settings.jev);
    const exported = serializeConfigurationProfiles(saved.filter((profile) => profile.id !== DEFAULT_JEV_PROFILE_ID));
    expect(exported).toContain("jev-key");
    const imported = await importConfigurationProfiles(JSON.parse(exported));
    const profile = imported.profiles.find((entry) => imported.importedIds.includes(entry.id));
    expect(profile?.jev).toEqual(settings.jev);
    expect(applyConfigurationProfile(PROFILE_SETTINGS, saved[0]).jev).toEqual(settings.jev);
    expect(applyConfigurationProfile(settings, { ...saved[0], jev: undefined }).jev).toEqual({ mode: "off", apiKey: "" });
  });

  it("updates a selected profile while preserving its identity and name", async () => {
    const saved = await saveConfigurationProfile("Work", PROFILE_SETTINGS);
    const original = saved[0];

    const updated = await updateConfigurationProfile(original.id, {
      ...PROFILE_SETTINGS,
      apiKey: "replacement-key",
      model: "new-model",
    });

    expect(updated).toHaveLength(2);
    expect(updated[0]).toMatchObject({
      id: original.id,
      name: "Work",
      apiKey: "replacement-key",
      model: "new-model",
      createdAt: original.createdAt,
    });
  });

  it("exports API keys and imports name conflicts as renamed copies", async () => {
    const saved = await saveConfigurationProfile("Work", PROFILE_SETTINGS);
    const exported = serializeConfigurationProfiles(saved.filter((profile) => profile.id !== DEFAULT_JEV_PROFILE_ID), "2026-08-18T00:00:00.000Z");
    expect(exported).toContain("secret-key");

    const firstImport = await importConfigurationProfiles(JSON.parse(exported));
    expect(firstImport.importedIds).toHaveLength(1);
    expect(firstImport.profiles.map((profile) => profile.name)).toContain("Work (imported)");

    const secondImport = await importConfigurationProfiles(JSON.parse(exported));
    expect(secondImport.profiles.map((profile) => profile.name)).toContain("Work (imported 2)");
    expect(new Set(secondImport.profiles.map((profile) => profile.id)).size).toBe(4);
    expect((await loadConfigurationProfiles()).filter((profile) => profile.id !== DEFAULT_JEV_PROFILE_ID).map((profile) => profile.apiKey))
      .toEqual(["secret-key", "secret-key", "secret-key"]);
  });

  it("rejects unsupported import files", async () => {
    await expect(importConfigurationProfiles({ version: 99, profiles: [] }))
      .rejects.toThrow("not supported");
  });
});
