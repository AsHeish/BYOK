import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunReport } from "./types";
import { loadRunReports, markInterruptedRunReports, saveRunReport } from "./storage";

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
