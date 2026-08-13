import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChatMessage, RunReport } from "./types";
import {
  clearChatMessages,
  loadChatSuggestions,
  loadChatMessages,
  loadRunReports,
  markInterruptedRunReports,
  resetChatSuggestions,
  saveChatSuggestions,
  saveChatMessages,
  saveRunReport,
} from "./storage";

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
    }));

    await saveChatMessages(messages);
    const reloaded = await loadChatMessages();
    expect(reloaded).toHaveLength(100);
    expect(reloaded[0].id).toBe("chat-2");
    expect(reloaded.at(-1)?.content).toBe("Message 101");

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
