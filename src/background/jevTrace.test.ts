import { describe, expect, it } from "vitest";
import type { JevActionDecision } from "./jevActions";
import { appendJevTrace, createJevTraceEntry, MAX_JEV_TRACE_ENTRIES, redactTraceUrl } from "./jevTrace";

const decision = (): JevActionDecision => ({
  kind: "fallback", operation: "click", reason: "Jev reports repeating actions without progress.",
  result: {
    answers: {
      operation: { choice: "click", confidence: 0.99, probabilities: { click: 0.99, done: 0.007, fallback: 0.003, scroll_down: 0 } },
      click_target: { choice: "el-7", confidence: 0.97, probabilities: { "el-7": 0.97, "el-8": 0.03 } },
    },
    ignoredAnswers: ["completion"], model: "jev-1.13.0-r7", attempts: 2, elapsedMs: 310, inputTokens: 1200, outputTokens: 40,
  },
});

describe("Jev trace entries", () => {
  it("keeps only origin and path of the page URL", () => {
    expect(redactTraceUrl("https://user:pw@example.test:8443/a/b?token=secret#frag")).toBe("https://example.test:8443/a/b");
    expect(redactTraceUrl("not a url")).toBe("");
    expect(redactTraceUrl(undefined)).toBe("");
  });

  it("records distributions, veto reason, model revision, attempts and timings", () => {
    const entry = createJevTraceEntry({ decision: decision(), outcome: "fallback", url: "https://example.test/quiz?answer=secret", at: 5 });
    expect(entry).toEqual({
      at: 5, url: "https://example.test/quiz", kind: "fallback", operation: "click", outcome: "fallback",
      reason: "Jev reports repeating actions without progress.", model: "jev-1.13.0-r7", attempts: 2, elapsedMs: 310,
      inputTokens: 1200, outputTokens: 40, ignoredAnswers: ["completion"],
      heads: [
        { question: "operation", choice: "click", confidence: 0.99, top: [{ option: "click", probability: 0.99 }, { option: "done", probability: 0.007 }, { option: "fallback", probability: 0.003 }] },
        { question: "click_target", choice: "el-7", confidence: 0.97, top: [{ option: "el-7", probability: 0.97 }, { option: "el-8", probability: 0.03 }] },
      ],
    });
  });

  it("records a failed request that has no answers, using the supplied elapsed time", () => {
    const entry = createJevTraceEntry({ decision: { kind: "fallback", operation: "fallback", reason: "Jev returned HTTP 429 after 3 attempts." }, outcome: "fallback", elapsedMs: 1500, url: "https://example.test/", at: 1 });
    expect(entry).toMatchObject({ heads: [], elapsedMs: 1500, reason: "Jev returned HTTP 429 after 3 attempts." });
    expect(entry).not.toHaveProperty("model");
    expect(entry).not.toHaveProperty("ignoredAnswers");
  });

  it("never carries the goal, page text, labels or typed values", () => {
    const secret = "SECRET-GOAL-TEXT";
    const entry = createJevTraceEntry({ decision: { ...decision(), action: { type: "fill", elementId: "el-7", text: secret } }, outcome: "fast", url: `https://example.test/p?q=${secret}`, at: 1 });
    expect(JSON.stringify(entry)).not.toContain(secret);
  });

  it("keeps the most recent entries within the cap", () => {
    let trace = [] as ReturnType<typeof createJevTraceEntry>[];
    for (let at = 0; at < MAX_JEV_TRACE_ENTRIES + 5; at += 1) trace = appendJevTrace(trace, createJevTraceEntry({ decision: decision(), outcome: "fast", at }));
    expect(trace).toHaveLength(MAX_JEV_TRACE_ENTRIES);
    expect(trace[0].at).toBe(5);
    expect(trace.at(-1)?.at).toBe(MAX_JEV_TRACE_ENTRIES + 4);
  });
});
