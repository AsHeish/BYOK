import { describe, expect, it, vi } from "vitest";
import type { PageObservation } from "../shared/types";
import { addJevUsage, getJevCandidates, getJevNavigationGoal, tryJevNavigation } from "./jevNavigation";

function observation(): PageObservation {
  return {
    url: "https://example.test/docs/start", title: "Documentation", text: "Browse the guides",
    elements: [{ id: "el-1", tag: "a", text: "Setup guide", href: "https://example.test/docs/setup", isDisabled: false, isSensitive: false }],
  };
}

function setup(mode: "fast" | "shadow" | "off" = "fast", choice = "link_1", confidence = 0.99) {
  const page = observation();
  return {
    settings: { mode, apiKey: "test-key" }, goal: "Find the setup instructions", observation: page,
    visitedUrls: new Set<string>(), signal: new AbortController().signal,
    readObservation: vi.fn().mockResolvedValue(page),
    transport: vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: "OK",
      responseText: JSON.stringify({ answers: { navigation: {
        type: "choice", choice, confidence,
        probabilities: { link_1: choice === "link_1" ? 1 : 0, fallback: choice === "fallback" ? 1 : 0 },
      } }, usage: { input_tokens: 100, output_tokens: 10 } }),
    }),
  };
}

describe("bounded Jev navigation", () => {
  it("accepts delegation only with one low-risk browser navigation", () => {
    const response = { mode: "browser", risk_level: "low", thought_summary: "Read docs", navigationGoal: "Find setup", action: { type: "navigate", url: "https://example.test/docs/start" } } as const;
    expect(getJevNavigationGoal(response)).toBe("Find setup");
    expect(getJevNavigationGoal({ ...response, mode: "chat" })).toBeUndefined();
    expect(getJevNavigationGoal({ ...response, risk_level: "high" })).toBeUndefined();
    expect(getJevNavigationGoal({ ...response, action: { type: "fill", text: "value" } })).toBeUndefined();
    expect(getJevNavigationGoal({ ...response, navigationGoal: "x".repeat(501) })).toBeUndefined();
    expect(getJevNavigationGoal({ ...response, actions: [response.action, response.action] })).toBeUndefined();
  });

  it("re-observes before returning one existing navigation action", async () => {
    const args = setup();
    const result = await tryJevNavigation(args);
    expect(args.transport).toHaveBeenCalledTimes(1);
    expect(args.readObservation).toHaveBeenCalledTimes(1);
    expect(result.response?.action).toEqual({ type: "navigate", url: "https://example.test/docs/setup" });
    expect(result.response?.navigationGoal).toBeUndefined();
    expect(result.outcome).toBe("fast");
    expect(addJevUsage(undefined, result)).toMatchObject({ requests: 1, fastDecisions: 1, inputTokens: 100 });
  });

  it("records shadow choices without returning an executable action", async () => {
    const args = setup("shadow");
    const result = await tryJevNavigation(args);
    expect(args.transport).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("shadow");
    expect(result.selectedUrl).toBe("https://example.test/docs/setup");
    expect(result.response).toBeUndefined();
    expect(args.readObservation).not.toHaveBeenCalled();
  });

  it.each(["off", "missing key", "missing goal", "no links"])("does not add a call for %s", async (scenario) => {
    const args = setup();
    if (scenario === "off") args.settings.mode = "off";
    if (scenario === "missing key") args.settings.apiKey = "";
    if (scenario === "missing goal") args.goal = "";
    if (scenario === "no links") args.observation.elements = [];
    const result = await tryJevNavigation(args);
    expect(args.transport).not.toHaveBeenCalled();
    expect(result.outcome).toBeUndefined();
    expect(result.response).toBeUndefined();
  });

  it.each([["fallback", 1], ["link_1", 0.7]] as const)("falls back for %s at confidence %s", async (choice, confidence) => {
    const result = await tryJevNavigation(setup("fast", choice, confidence));
    expect(result.outcome).toBe("fallback");
    expect(result.response).toBeUndefined();
  });

  it("rejects a stale page despite re-used element IDs", async () => {
    const args = setup();
    args.readObservation.mockResolvedValue({ ...observation(), text: "A different page revision" });
    const result = await tryJevNavigation(args);
    expect(args.readObservation).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("fallback");
    expect(result.response).toBeUndefined();
  });

  it("disables Jev for the run after an API error", async () => {
    const args = setup();
    args.transport.mockResolvedValue({ ok: false, status: 429, statusText: "rate limit", responseText: "" });
    const result = await tryJevNavigation(args);
    expect(result).toMatchObject({ disableForRun: true, outcome: "fallback" });
    expect(args.transport).toHaveBeenCalledTimes(1);
  });

  it("does not turn Stop into an LLM fallback", async () => {
    const args = setup();
    const controller = new AbortController();
    args.signal = controller.signal;
    args.readObservation.mockImplementation(async () => { controller.abort(); return observation(); });
    await expect(tryJevNavigation(args)).rejects.toMatchObject({ name: "ModelRequestCancelledError" });
  });

  it.each([
    "https://other.test/docs/setup", "javascript:alert(1)", "http://example.test/docs/setup",
    "https://user:password@example.test/docs/setup", "https://example.test/docs/delete",
    "https://example.test/docs/setup?token=secret", "https://example.test/docs/setup#anchor",
    "https://example.test/account/setup", "https://example.test/docs/file.pdf",
    "https://example.test/docs/submit", "https://example.test/docs/approve", "https://example.test/docs/sign-in",
    "https://example.test/docs/%2564elete", "https://example.test/docs/%64elete",
  ])("excludes unsafe or unsupported destination %s", (href) => {
    const page = observation();
    page.elements.push({ ...page.elements[0], id: "el-2", href });
    const candidates = getJevCandidates(page, new Set());
    expect(candidates).toHaveLength(1);
    expect(candidates[0].url).toBe("https://example.test/docs/setup");
  });

  it("excludes sensitive, disabled, framed and already visited links", () => {
    const page = observation();
    page.elements = [
      ...page.elements,
      { ...page.elements[0], isSensitive: true, href: "/docs/private" },
      { ...page.elements[0], isDisabled: true, href: "/docs/disabled" },
      { ...page.elements[0], frameContext: "frame-1", href: "/docs/framed" },
      { ...page.elements[0], href: "/docs/start" },
    ];
    expect(getJevCandidates(page, new Set())).toHaveLength(1);
    expect(getJevCandidates(page, new Set(["https://example.test/docs/setup"]))).toHaveLength(0);
  });
});