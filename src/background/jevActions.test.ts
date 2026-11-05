import { describe, expect, it, vi } from "vitest";
import type { PageObservation } from "../shared/types";
import type { ModelHttpRequest } from "./modelClient";
import { buildJevActionSpace, describeJevOutcome, JEV_MAX_ELEMENTS, JEV_NO_VISIBLE_CHANGE, progressKey, requestJevAction, selectJevElements, semanticPageKey, type JevHistoryEntry } from "./jevActions";
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

function transport(choices: Record<string, string>, confidence: number | Record<string, number> = 1) {
  return vi.fn(async (request: ModelHttpRequest) => {
    const questions = JSON.parse(request.body).questions as Record<string, { criteria: Record<string, string> }>;
    return { ok: true, status: 200, statusText: "OK", responseText: JSON.stringify({ answers: Object.fromEntries(
      Object.entries(questions).map(([key, question]) => {
        const choice = choices[key] || (key === "completion" ? "incomplete" : "fallback");
        const level = typeof confidence === "number" ? confidence : confidence[key] ?? 1;
        return [key, { type: "choice", choice, confidence: level, probabilities: Object.fromEntries(Object.keys(question.criteria).map((option) => [option, Number(option === choice)])) }];
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

  it("scopes choice clicks and selects to their group while other Jev actions keep the full form state", async () => {
    const observation = page();
    observation.formState = "form-1";
    observation.elements[3].scopeState = "select-state";
    observation.elements.push({ id: "radio", fingerprint: "radio-fp", scopeState: "group-state", tag: "input", type: "radio", label: "Yes", isDisabled: false, isSensitive: false });
    const click = await requestJevAction({ ...args(), observation }, transport({ operation: "click", click_target: "radio" }));
    expect(click.action?.guard).toMatchObject({ scopes: { radio: "group-state" }, targets: { radio: "radio-fp" } });
    expect(click.action?.guard?.formState).toBeUndefined();
    const select = await requestJevAction({ ...args(), observation }, transport({ operation: "select", select_target: "option_1" }));
    expect(select.action?.guard?.scopes).toEqual({ select: "select-state" });
    expect(select.action?.guard?.formState).toBeUndefined();
    const button = await requestJevAction({ ...args(), observation }, transport({ operation: "click", click_target: "button" }));
    expect(button.action?.guard?.formState).toBe("form-1");
    expect(button.action?.guard?.scopes).toBeUndefined();
    const fill = await requestJevAction({ ...args(), observation }, transport({ operation: "fill", fill_target: "search", fill_value: "value_1" }));
    expect(fill.action?.guard?.formState).toBe("form-1");
    expect(fill.action?.guard?.scopes).toBeUndefined();
  });

  it("keeps the full form state for a click when the control reports no group state", async () => {
    const observation = page();
    observation.formState = "form-1";
    observation.elements.push({ id: "radio", fingerprint: "radio-fp", tag: "input", type: "radio", label: "Yes", isDisabled: false, isSensitive: false });
    const click = await requestJevAction({ ...args(), observation }, transport({ operation: "click", click_target: "radio" }));
    expect(click.action?.guard?.formState).toBe("form-1");
    expect(click.action?.guard?.scopes).toBeUndefined();
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

describe("Jev element selection", () => {
  const many = (count: number, interactiveElementCount = count): PageObservation => ({
    documentId: "document-1", url: "https://example.test/long", title: "Long", text: "Many controls", interactiveElementCount,
    elements: Array.from({ length: count }, (_, index) => ({ id: `el-${index}`, fingerprint: `fp-${index}`, tag: "button", label: `Item ${index}`, isDisabled: false, isSensitive: false })),
  });

  it("offers up to 250 controls and reports the rest as omitted", () => {
    const selection = selectJevElements(many(250, 400));
    expect(selection.elements).toHaveLength(250);
    expect(selection.omitted).toBe(150);
    expect(JEV_MAX_ELEMENTS).toBe(250);
  });

  it("reports nothing omitted when every control is offered", () => {
    expect(selectJevElements(many(40))).toMatchObject({ omitted: 0, elements: expect.any(Array) });
  });

  it("filters unsafe controls before applying the count, so disabled controls do not consume slots", () => {
    const observation = many(90);
    for (const element of observation.elements.slice(0, 20)) element.isDisabled = true;
    const selection = selectJevElements(observation);
    expect(selection.elements).toHaveLength(70);
    expect(selection.elements[0].id).toBe("el-20");
  });

  it("stops at the character budget and counts the remainder as omitted instead of listing it half-described", () => {
    const observation = many(250);
    for (const element of observation.elements) element.context = "x".repeat(300);
    const selection = selectJevElements(observation);
    expect(selection.elements.length).toBeLessThan(250);
    expect(selection.elements.length + selection.omitted).toBe(250);
    expect(selection.elements.map((element) => element.id)).toEqual(observation.elements.slice(0, selection.elements.length).map((element) => element.id));
  });

  it("sends the omitted count and a scroll hint to Jev, and builds targets only from offered controls", async () => {
    const observation = many(120, 300);
    const request = transport({ operation: "click", click_target: "el-5" });
    const result = await requestJevAction({ ...args(), observation }, request);
    const state = JSON.parse(request.mock.calls[0][0].body).state;
    expect(state.elements).toHaveLength(120);
    expect(state.omittedControls).toBe(180);
    expect(state.controlsNote).toContain("scroll");
    expect(result.action).toMatchObject({ type: "click", elementId: "el-5" });
    expect(Object.keys(buildJevActionSpace(observation, "Open item", false).targets.click)).toHaveLength(120);
  });

  it("omits the hint when nothing is hidden", async () => {
    const request = transport({ operation: "click", click_target: "button" });
    await requestJevAction(args(), request);
    const state = JSON.parse(request.mock.calls[0][0].body).state;
    expect(state.omittedControls).toBe(0);
    expect(state).not.toHaveProperty("controlsNote");
  });
});
describe("Jev outcome history and stuck detection", () => {
  const entry = (outcome?: string): JevHistoryEntry => ({ action: "click", target: "button", url: "https://example.test/search?q=docs", result: "Clicked", ...(outcome ? { outcome } : {}) });
  const stuckChoices = { operation: "click", click_target: "button", stuck: "stuck" };
  const questionKeys = (request: ReturnType<typeof transport>) => Object.keys(JSON.parse(request.mock.calls[0][0].body).questions);

  it("classifies navigation, change and no change after an action", () => {
    const before = page();
    expect(describeJevOutcome(before, page())).toBe(JEV_NO_VISIBLE_CHANGE);
    expect(describeJevOutcome(before, { ...page(), url: "https://example.test/next" })).toBe("navigated to https://example.test/next");
    const typed = page();
    typed.elements[0].value = "typescript";
    expect(describeJevOutcome(before, typed)).toBe("page changed");
    expect(describeJevOutcome(before, { ...page(), url: `https://example.test/${"a".repeat(400)}` })).toHaveLength("navigated to ".length + 200);
  });

  it("sends recorded outcomes to Jev with the recent actions", async () => {
    const request = transport({ operation: "click", click_target: "button" });
    await requestJevAction({ ...args(), history: [entry("navigated to https://example.test/next"), entry(JEV_NO_VISIBLE_CHANGE)] }, request);
    const recent = JSON.parse(request.mock.calls[0][0].body).state.recentActions;
    expect(recent.map((action: JevHistoryEntry) => action.outcome)).toEqual(["navigated to https://example.test/next", JEV_NO_VISIBLE_CHANGE]);
  });

  it("asks the stuck question only once there are two actions to compare", async () => {
    const early = transport(stuckChoices);
    await requestJevAction({ ...args(), history: [entry(JEV_NO_VISIBLE_CHANGE)] }, early);
    expect(questionKeys(early)).not.toContain("stuck");
    const later = transport(stuckChoices);
    await requestJevAction({ ...args(), history: [entry(), entry(JEV_NO_VISIBLE_CHANGE)] }, later);
    expect(questionKeys(later)).toContain("stuck");
  });

  it("hands over when Jev is confidently stuck and an unchanged page corroborates it", async () => {
    const result = await requestJevAction({ ...args(), history: [entry("page changed"), entry(JEV_NO_VISIBLE_CHANGE)] }, transport(stuckChoices));
    expect(result).toMatchObject({ kind: "fallback", reason: expect.stringContaining("repeating actions") });
    expect(result.action).toBeUndefined();
  });

  it("does not veto on the stuck answer without an observed unchanged page", async () => {
    const result = await requestJevAction({ ...args(), history: [entry("page changed"), entry("navigated to https://example.test/next")] }, transport(stuckChoices));
    expect(result).toMatchObject({ kind: "action", action: { type: "click", elementId: "button" } });
  });

  it("does not veto when the stuck answer is below the confidence floor", async () => {
    const result = await requestJevAction({ ...args(), history: [entry(), entry(JEV_NO_VISIBLE_CHANGE)] }, transport(stuckChoices, { stuck: 0.9 }));
    expect(result.kind).toBe("action");
  });

  it("only considers the two most recent actions for corroboration", async () => {
    const result = await requestJevAction({ ...args(), history: [entry(JEV_NO_VISIBLE_CHANGE), entry("page changed"), entry("page changed")] }, transport(stuckChoices));
    expect(result.kind).toBe("action");
  });

  it("ignores an unusable stuck answer instead of failing the decision", async () => {
    const result = await requestJevAction({ ...args(), history: [entry(JEV_NO_VISIBLE_CHANGE), entry(JEV_NO_VISIBLE_CHANGE)] }, transport({ operation: "click", click_target: "button" }));
    expect(result.kind).toBe("action");
  });

  it("does not let the stuck answer block a verified completion", async () => {
    const result = await requestJevAction({ ...args(), history: [entry(JEV_NO_VISIBLE_CHANGE), entry(JEV_NO_VISIBLE_CHANGE)] }, transport({ operation: "done", completion: "verified", stuck: "stuck" }));
    expect(result.kind).toBe("done");
  });
});

describe("Jev minimum confidence", () => {
  const flows = [
    { name: "click", choices: { operation: "click", click_target: "button" }, heads: ["operation", "click_target"], kind: "action" },
    { name: "fill", choices: { operation: "fill", fill_target: "search", fill_value: "value_1" }, heads: ["operation", "fill_target", "fill_value"], kind: "action" },
    { name: "done", choices: { operation: "done", completion: "verified" }, heads: ["operation", "completion"], kind: "done" },
  ] as const;
  const levels = [
    { floor: undefined, level: 0.94, acts: false },
    { floor: undefined, level: 0.95, acts: true },
    { floor: 0.97, level: 0.96, acts: false },
    { floor: 0.97, level: 0.97, acts: true },
    { floor: 0.5, level: 0.9, acts: false },
    { floor: 1.5, level: 0.9, acts: false },
    { floor: Number.NaN, level: 0.9, acts: false },
  ];

  it.each(levels)("gates every head at floor $floor, confidence $level", async ({ floor, level, acts }) => {
    for (const flow of flows) {
      for (const head of flow.heads) {
        const result = await requestJevAction({ ...args(), ...(floor === undefined ? {} : { confidenceFloor: floor }) }, transport(flow.choices, { [head]: level }));
        expect(result.kind, `${flow.name} ${head}`).toBe(acts ? flow.kind : "fallback");
      }
    }
  });

  it("does not let the user floor weaken the stuck veto threshold", async () => {
    const history = [{ action: "click", url: "https://example.test/", result: "ok", outcome: JEV_NO_VISIBLE_CHANGE }, { action: "click", url: "https://example.test/", result: "ok", outcome: JEV_NO_VISIBLE_CHANGE }];
    const result = await requestJevAction({ ...args(), history, confidenceFloor: 0.99 }, transport({ operation: "click", click_target: "button", stuck: "stuck" }, { stuck: 0.96 }));
    expect(result.kind).toBe("fallback");
    expect(result.reason).toContain("repeating");
  });
});

describe("Jev replace-existing fill (opt-in)", () => {
  const filledPage = (): PageObservation => {
    const observation = page();
    observation.elements[0] = { ...observation.elements[0], value: "old query" };
    return observation;
  };
  const fillChoices = { operation: "fill", fill_target: "search", fill_value: "value_1" };

  it("does not offer a filled field by default", () => {
    expect(buildJevActionSpace(filledPage(), 'Search for "typescript"', false).targets.fill).not.toHaveProperty("search");
  });

  it("offers a filled field with its current value when enabled, but never a sensitive or read-only one", () => {
    const observation = filledPage();
    observation.elements.push(
      { id: "pw", fingerprint: "pw", tag: "input", role: "textbox", type: "password", label: "Password", value: "secret", isDisabled: false, isSensitive: true },
      { id: "ro", fingerprint: "ro", tag: "input", role: "textbox", label: "Locked", value: "fixed", isReadOnly: true, isDisabled: false, isSensitive: false },
    );
    const space = buildJevActionSpace(observation, 'Search for "typescript"', false, true);
    expect(Object.keys(space.targets.fill)).toEqual(["search"]);
    expect(space.questions.fill_target.criteria.search).toContain('current value="old query"');
    expect(space.questions.operation.criteria.fill).toContain("replaced only when the user's goal asks");
  });

  it("marks the guard to allow replacement only when the setting is on", async () => {
    const on = await requestJevAction({ ...args(), observation: filledPage(), replaceFilledFields: true }, transport(fillChoices));
    expect(on).toMatchObject({ kind: "action", action: { type: "fill", elementId: "search", text: "typescript", guard: { replaceExisting: true } } });
    const off = requestJevAction({ ...args(), observation: filledPage() }, transport(fillChoices));
    await expect(off).rejects.toThrow("invalid decision");
  });

  it("does not mark an ordinary empty-field fill", async () => {
    const result = await requestJevAction({ ...args(), replaceFilledFields: true }, transport(fillChoices));
    expect(result.action?.guard?.replaceExisting).toBe(true);
    const unflagged = await requestJevAction(args(), transport(fillChoices));
    expect(unflagged.action?.guard).not.toHaveProperty("replaceExisting");
  });

  it("ignores a replacement flag supplied by the caller's own guard", () => {
    const observation = filledPage();
    const forged = { type: "fill" as const, elementId: "search", text: "x", guard: { id: "x", documentId: "document-1", url: observation.url, targets: {}, replaceExisting: true } };
    expect(guardObservedAction(forged, observation)?.guard).not.toHaveProperty("replaceExisting");
    expect(guardObservedAction({ type: "click", elementId: "button" }, observation, { replaceExisting: true })?.guard).not.toHaveProperty("replaceExisting");
  });

  it("fails closed when an element does not report whether it is sensitive", () => {
    const observation = filledPage();
    const { isSensitive: _omitted, ...unknown } = observation.elements[0];
    observation.elements[0] = unknown as PageObservation["elements"][number];
    expect(guardObservedAction({ type: "fill", elementId: "search", text: "x" }, observation, { replaceExisting: true })?.guard).not.toHaveProperty("replaceExisting");
  });
});
