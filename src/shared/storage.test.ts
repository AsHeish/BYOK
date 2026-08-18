import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChatMessage, AgentSettings, RunReport } from "./types";
import {
  clearChatMessages,
  importConfigurationProfiles,
  loadChatSuggestions,
  loadChatMessages,
  loadConfigurationProfiles,
  loadRunReports,
  markInterruptedRunReports,
  resetChatSuggestions,
  saveChatSuggestions,
  saveChatMessages,
  saveConfigurationProfile,
  saveRunReport,
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
  it("updates a selected profile while preserving its identity and name", async () => {
    const saved = await saveConfigurationProfile("Work", PROFILE_SETTINGS);
    const original = saved[0];

    const updated = await updateConfigurationProfile(original.id, {
      ...PROFILE_SETTINGS,
      apiKey: "replacement-key",
      model: "new-model",
    });

    expect(updated).toHaveLength(1);
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
    const exported = serializeConfigurationProfiles(saved, "2026-08-18T00:00:00.000Z");
    expect(exported).toContain("secret-key");

    const firstImport = await importConfigurationProfiles(JSON.parse(exported));
    expect(firstImport.importedIds).toHaveLength(1);
    expect(firstImport.profiles.map((profile) => profile.name)).toContain("Work (imported)");

    const secondImport = await importConfigurationProfiles(JSON.parse(exported));
    expect(secondImport.profiles.map((profile) => profile.name)).toContain("Work (imported 2)");
    expect(new Set(secondImport.profiles.map((profile) => profile.id)).size).toBe(3);
    expect((await loadConfigurationProfiles()).map((profile) => profile.apiKey))
      .toEqual(["secret-key", "secret-key", "secret-key"]);
  });

  it("rejects unsupported import files", async () => {
    await expect(importConfigurationProfiles({ version: 99, profiles: [] }))
      .rejects.toThrow("not supported");
  });
});
