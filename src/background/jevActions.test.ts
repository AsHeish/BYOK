import { describe, expect, it, vi } from "vitest";
import type { PageObservation } from "../shared/types";
import type { ModelHttpRequest } from "./modelClient";
import { buildJevActionSpace, progressKey, requestJevAction, semanticPageKey } from "./jevActions";
import { guardObservedAction, isSafeNavigationUrl, validateAgentAction } from "./safety";

const page = (): PageObservation => ({
  documentId: "document-1", url: "https://example.test/search?q=docs", title: "Search", text: "Search and results",
  elements: [
    { id: "search", fingerprint: "field", tag: "input", role: "searchbox", label: "Search", value: "", isDisabled: false, isSensitive: false },
    { id: "button", fingerprint: "button", tag: "button", type: "submit", label: "Search", isDisabled: false, isSensitive: false },
    { id: "link", fingerprint: "link", tag: "a", label: "Result", href: "https://other.test/repository", isDisabled: false, isSensitive: false },
    { id: "select", fingerprint: "select", tag: "select", label: "Sort", value: "Recent", options: ["Recent", "Popular"], isDisabled: false, isSensitive: false },
  ],
});

function transport(choices: Record<string, string>, confidence = 1) {
  return vi.fn(async (request: ModelHttpRequest) => {
    const questions = JSON.parse(request.body).questions as Record<string, { criteria: Record<string, string> }>;
    return { ok: true, status: 200, statusText: "OK", responseText: JSON.stringify({ answers: Object.fromEntries(
      Object.entries(questions).map(([key, question]) => {
        const choice = choices[key] || (key === "completion" ? "incomplete" : "fallback");
        return [key, { type: "choice", choice, confidence, probabilities: Object.fromEntries(Object.keys(question.criteria).map((option) => [option, Number(option === choice)])) }];
      }),
    ), usage: { input_tokens: 100, output_tokens: 20 } }) };
  });
}

const args = () => ({ apiKey: "test-key", goal: 'Search for "typescript"', observation: page(), history: [], allowTextHelper: false, signal: new AbortController().signal });

describe("Jev observed action policy", () => {
  it("uses a single request and only the target for the selected operation", async () => {
    const request = transport({ operation: "click", click_target: "button", fill_target: "search", fill_value: "value_1" });
    const result = await requestJevAction(args(), request);
    expect(request).toHaveBeenCalledTimes(1);
    expect(Object.keys(JSON.parse(request.mock.calls[0][0].body).questions)).toContain("fill_target");
    expect(result).toMatchObject({ kind: "action", action: { type: "click", elementId: "button", guard: { documentId: "document-1", targets: { button: "button" } } } });
    expect(result.action?.text).toBeUndefined();
  });

  it("offers observed cross-site links and query URLs without a docs-path restriction", () => {
    expect(buildJevActionSpace(page(), "Open result", false).targets.click.link).toMatchObject({ type: "click", elementId: "link" });
  });

  it("fills only verbatim quoted values in Only mode", async () => {
    const result = await requestJevAction(args(), transport({ operation: "fill", fill_target: "search", fill_value: "value_1" }));
    expect(result.action).toMatchObject({ type: "fill", text: "typescript", elementId: "search" });
    expect(buildJevActionSpace(page(), "Search for a repo", false).questions.fill_target).toBeUndefined();
    expect(buildJevActionSpace(page(), args().goal, false).questions.fill_value.criteria).not.toHaveProperty("generate");
  });

  it("requires explicit generated-text handoff in hybrid mode", async () => {
    const result = await requestJevAction({ ...args(), allowTextHelper: true }, transport({ operation: "fill", fill_target: "search", fill_value: "generate" }));
    expect(result.kind).toBe("text");
    expect(result.action?.guard).toBeDefined();
  });

  it("selects exact observed dropdown options", async () => {
    const result = await requestJevAction(args(), transport({ operation: "select", select_target: "option_1" }));
    expect(result.action).toMatchObject({ type: "select", elementId: "select", text: "Popular" });
  });

  it("does not block controls based on sensitive or transactional words", () => {
    const observation = page();
    observation.elements[0].value = "existing";
    observation.elements[1].label = "Purchase";
    observation.elements[2].href = "javascript:alert(1)";
    observation.elements[3].isSensitive = true;
    const space = buildJevActionSpace(observation, args().goal, true);
    expect(Object.keys(space.targets.fill)).toHaveLength(0);
    expect(space.targets.click.button).toBeDefined();
    expect(space.targets.click.link).toBeDefined();
    expect(Object.keys(space.targets.select)).toHaveLength(1);
  });

  it("accepts high-risk labels and ordinary authenticated URLs without policy refusal", () => {
    const observation = page();
    observation.elements[0].isSensitive = true;
    observation.elements[0].label = "Explain DELETE and access tokens: Your Submission";
    observation.elements[1].label = "Submit answers";
    expect(isSafeNavigationUrl("https://example.test/account/delete?token=session")).toBe(true);
    const action = { type: "fill" as const, elementId: "search", text: "answer" };
    expect(validateAgentAction({ task: "Fill this form", observation, modelResponse: { mode: "browser", risk_level: "high", thought_summary: "Fill", action } }).allowed).toBe(true);
    expect(guardObservedAction(action, observation)?.guard?.targets.search).toBe("field");
  });

  it("reports stale IDs as recoverable instead of sensitive actions", () => {
    const result = validateAgentAction({ task: "Fill a field", observation: page(), modelResponse: { mode: "browser", risk_level: "low", thought_summary: "Fill", action: { type: "fill", elementId: "old-id", text: "answer" } } });
    expect(result).toMatchObject({ allowed: false, recoverable: true, reason: expect.stringContaining("not currently observed") });
    expect(result.reason).not.toContain("sensitive");
  });

  it("requires both DONE and verified completion", async () => {
    expect((await requestJevAction(args(), transport({ operation: "done" }))).kind).toBe("fallback");
    expect((await requestJevAction(args(), transport({ operation: "done", completion: "verified" }))).kind).toBe("done");
  });

  it("does not execute low-confidence decisions", async () => {
    expect((await requestJevAction(args(), transport({ operation: "click", click_target: "button" }, 0.6))).kind).toBe("fallback");
  });

  it("requires document identity before calling Jev", async () => {
    const request = transport({ operation: "click" });
    const observation = page();
    observation.documentId = undefined;
    expect((await requestJevAction({ ...args(), observation }, request)).kind).toBe("fallback");
    expect(request).not.toHaveBeenCalled();
  });

  it("tracks semantic focus and expanded state as progress", () => {
    const observation = page();
    const before = semanticPageKey(observation);
    observation.elements[0].isFocused = true;
    expect(semanticPageKey(observation)).not.toBe(before);
  });

  it("detects navigation cycles across document IDs without conflating different targets", () => {
    const observation = page();
    const action = { type: "click" as const, elementId: "button" };
    const before = progressKey(observation, action);
    observation.documentId = "reloaded-document";
    observation.elements[0].fingerprint = "new-fingerprint";
    expect(progressKey(observation, action)).toBe(before);
    expect(progressKey(observation, { ...action, elementId: "link" })).not.toBe(before);
    observation.elements[0].isFocused = true;
    expect(progressKey(observation, action)).not.toBe(before);
  });
});