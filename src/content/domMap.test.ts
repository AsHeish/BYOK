// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkWaitCondition, getDocumentId, getElementFingerprint, getFormStateFingerprint, getMappedElement, getScopeFormState, isSensitiveElement, observePage } from "./domMap";
import * as domMap from "./domMap";
import { executeAction } from "./actions";
import { guardObservedAction } from "../background/safety";

describe("sensitive control detection", () => {
  it.each([
    '<input type="password" />', '<input autocomplete="one-time-code" />',
    '<input autocomplete="section-payment cc-number" />', '<textarea name="apiKey"></textarea>',
    '<div role="textbox"><input name="private_key" /></div>',
  ])("identifies sensitive control values for redaction: %s", (markup) => {
    document.body.innerHTML = markup;
    expect(isSensitiveElement(document.body.firstElementChild as HTMLElement)).toBe(true);
  });

  it("keeps ordinary search and user-staged upload controls available", () => {
    document.body.innerHTML = '<input type="search" aria-label="Search repositories" /><input type="file" />';
    expect(Array.from(document.body.children).map((element) => isSensitiveElement(element as HTMLElement))).toEqual([false, false]);
  });
});

describe("DOM settlement signature", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main>
        <input id="name" value="" />
        <input id="approved" type="checkbox" />
        <select id="priority">
          <option value="low">Low</option>
          <option value="high">High</option>
        </select>
        <button id="submit">Submit</button>
      </main>
    `;
  });

  it("changes when form state changes without changing text or element count", () => {
    const initialText = document.body.textContent;
    const initialElementCount = document.querySelectorAll("*").length;
    const signatures = [signature()];

    (document.querySelector("#name") as HTMLInputElement).value = "Ashish";
    signatures.push(signature());

    (document.querySelector("#approved") as HTMLInputElement).checked = true;
    signatures.push(signature());

    (document.querySelector("#priority") as HTMLSelectElement).value = "high";
    signatures.push(signature());

    (document.querySelector("#submit") as HTMLButtonElement).disabled = true;
    signatures.push(signature());

    expect(document.body.textContent).toBe(initialText);
    expect(document.querySelectorAll("*")).toHaveLength(initialElementCount);
    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it("detects state changes inside an open shadow root", () => {
    const host = document.createElement("section");
    document.body.append(host);
    const shadowRoot = host.attachShadow({ mode: "open" });
    shadowRoot.innerHTML = '<input id="shadow-input" value="" />';
    const initialTopLevelCount = document.querySelectorAll("*").length;
    const before = signature();

    (shadowRoot.querySelector("#shadow-input") as HTMLInputElement).value = "updated";
    const after = signature();

    expect(document.querySelectorAll("*")).toHaveLength(initialTopLevelCount);
    expect(after).not.toBe(before);
  });
});

function signature(): string {
  return checkWaitCondition({ condition: "dom_stable" }).signature;
}

describe("guarded content execution", () => {
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  const originalRangeRect = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
  beforeEach(() => {
    vi.stubGlobal("PointerEvent", class extends PointerEvent {
      constructor(type: string, init?: PointerEventInit) { super(type, { ...init, view: null }); }
    });
    vi.stubGlobal("MouseEvent", class extends MouseEvent {
      constructor(type: string, init?: MouseEventInit) { super(type, { ...init, view: null }); }
    });
    document.body.innerHTML = '<button id="search" style="opacity:1">Search</button><input id="query" style="opacity:1" />';
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 10, y: 10, top: 10, left: 10, right: 110, bottom: 40, width: 100, height: 30, toJSON() {} });
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{ width: 100, height: 30 }] as unknown as DOMRectList);
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => document.querySelector("#search")!.getBoundingClientRect() });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => document.querySelector("#search") });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(document, "elementFromPoint");
    if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    if (originalRangeRect) Object.defineProperty(Range.prototype, "getBoundingClientRect", originalRangeRect);
    else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  });

  function action() {
    const observation = observePage();
    const target = observation.elements.find((element) => element.text === "Search")!;
    expect(target).toBeDefined();
    expect(observation.documentId).toBe(getDocumentId());
    expect(target.fingerprint).toBe(getElementFingerprint(document.querySelector("#search")!));
    const guarded = guardObservedAction({ type: "click", elementId: target.id }, observation);
    expect(guarded?.guard).toBeDefined();
    return guarded!;
  }

  it("executes once and rejects replay", async () => {
    const guarded = action();
    const click = vi.fn();
    document.querySelector("#search")!.addEventListener("click", click);
    expect((await executeAction(guarded)).ok).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
    expect(await executeAction(guarded)).toMatchObject({ ok: false, notExecuted: true });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("rejects changed form values outside the target's parent for default and scoped guards on a non-choice target", async () => {
    const observation = observePage();
    const target = observation.elements.find((element) => element.text === "Search")!;
    const strict = guardObservedAction({ type: "click", elementId: target.id }, observation)!;
    const scopedRequest = guardObservedAction({ type: "click", elementId: target.id }, observation, { scoped: true })!;
    expect(scopedRequest.guard?.scopes).toBeUndefined();
    expect(scopedRequest.guard?.formState).toBe(observation.formState);
    const before = getFormStateFingerprint();
    (document.querySelector("#query") as HTMLInputElement).value = "changed";
    expect(getFormStateFingerprint()).not.toBe(before);
    for (const guarded of [strict, scopedRequest]) {
      expect(await executeAction(guarded)).toMatchObject({ ok: false, notExecuted: true, message: expect.stringContaining("Form values changed") });
    }
  });

  describe("scoped guards for choice controls", () => {
    const groups = `<fieldset id="q1"><input id="a1" type="radio" name="q1" style="opacity:1" /><input id="a2" type="radio" name="q1" style="opacity:1" /></fieldset>
      <fieldset id="q2"><input id="b1" type="radio" name="q2" style="opacity:1" /><input id="b2" type="radio" name="q2" style="opacity:1" /></fieldset>`;
    const byId = (id: string) => document.querySelector(`#${id}`) as HTMLInputElement;

    function guards(id: string) {
      const observation = observePage();
      const info = observation.elements.find((element) => getMappedElement(element.id) === byId(id))!;
      expect(info?.scopeState).toBeTruthy();
      return {
        scoped: guardObservedAction({ type: "click", elementId: info.id }, observation, { scoped: true })!,
        strict: guardObservedAction({ type: "click", elementId: info.id }, observation)!,
      };
    }

    function hit(id: string) {
      Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => byId(id) });
    }

    beforeEach(() => document.body.insertAdjacentHTML("beforeend", groups));

    it("keeps a good decision when an unrelated field outside its group changes, while a strict guard still refuses", async () => {
      const { scoped, strict } = guards("a1");
      expect(scoped.guard?.scopes).toEqual({ [scoped.elementId!]: expect.any(String) });
      expect(scoped.guard?.formState).toBeUndefined();
      (document.querySelector("#query") as HTMLInputElement).value = "changed";
      hit("a1");
      expect(await executeAction(strict)).toMatchObject({ ok: false, notExecuted: true, message: expect.stringContaining("Form values changed") });
      const click = vi.fn();
      byId("a1").addEventListener("click", click);
      expect((await executeAction(scoped)).ok).toBe(true);
      expect(click).toHaveBeenCalledTimes(1);
      expect(byId("a1").checked).toBe(true);
    });

    it("keeps a good decision when a different question's answer changes", async () => {
      const { scoped } = guards("a1");
      byId("b2").checked = true;
      hit("a1");
      expect((await executeAction(scoped)).ok).toBe(true);
      expect(byId("a1").checked).toBe(true);
    });

    it("refuses when another option in the same group changed", async () => {
      const { scoped } = guards("a1");
      byId("a2").checked = true;
      hit("a1");
      expect(await executeAction(scoped)).toMatchObject({ ok: false, notExecuted: true, message: expect.stringContaining("group changed") });
      expect(byId("a1").checked).toBe(false);
    });

    it("groups radios that share a name even without a fieldset or group container", async () => {
      document.body.insertAdjacentHTML("beforeend", '<div><input id="c1" type="radio" name="loose" style="opacity:1" /></div><div><input id="c2" type="radio" name="loose" style="opacity:1" /></div>');
      const { scoped } = guards("c1");
      byId("c2").checked = true;
      hit("c1");
      expect(await executeAction(scoped)).toMatchObject({ ok: false, notExecuted: true, message: expect.stringContaining("group changed") });
    });

    it("refuses when the target's own state changed", async () => {
      const { scoped } = guards("a1");
      byId("a1").disabled = true;
      hit("a1");
      expect((await executeAction(scoped)).ok).toBe(false);
      expect(byId("a1").checked).toBe(false);
    });

    it("still refuses a replayed scoped guard", async () => {
      const { scoped } = guards("a1");
      hit("a1");
      expect((await executeAction(scoped)).ok).toBe(true);
      expect(await executeAction(scoped)).toMatchObject({ ok: false, notExecuted: true });
    });

    it("keeps a scoped select on a select-specific scope and refuses its own change", async () => {
      document.body.insertAdjacentHTML("beforeend", '<div><select id="sort" style="opacity:1"><option>A</option><option>B</option></select></div>');
      const observation = observePage();
      const info = observation.elements.find((element) => getMappedElement(element.id) === byId("sort"))!;
      const scoped = guardObservedAction({ type: "select", elementId: info.id, text: "B" }, observation, { scoped: true })!;
      expect(scoped.guard?.scopes?.[info.id]).toBeTruthy();
      (byId("sort") as unknown as HTMLSelectElement).selectedIndex = 1;
      expect(await executeAction(scoped)).toMatchObject({ ok: false, notExecuted: true });
    });

    it("never scopes fill, scroll, or actions on controls that report no group state", () => {
      const observation = observePage();
      const query = observation.elements.find((element) => getMappedElement(element.id) === document.querySelector("#query"))!;
      expect(query.scopeState).toBeUndefined();
      for (const action of [{ type: "fill" as const, elementId: query.id, text: "x" }, { type: "click" as const, elementId: query.id }, { type: "scroll" as const, direction: "down" as const }]) {
        const guard = guardObservedAction(action, observation, { scoped: true })!.guard;
        expect(guard?.scopes).toBeUndefined();
        expect(guard?.formState).toBe(observation.formState);
      }
      const radio = observation.elements.find((element) => getMappedElement(element.id) === byId("a1"))!;
      const fill = guardObservedAction({ type: "fill", elementId: radio.id, text: "x" }, observation, { scoped: true })!.guard;
      expect(fill?.scopes).toBeUndefined();
    });

    it("ignores sensitive controls in a group and keeps private values out of the hash, even when redaction would alter it", () => {
      byId("q1").insertAdjacentHTML("beforeend", '<input id="secret" type="password" style="opacity:1" />');
      const secret = byId("secret");
      for (const character of "0123456789abcdefghijklmnopqrstuvwxyz") {
        secret.value = character;
        const observation = observePage();
        const info = observation.elements.find((element) => getMappedElement(element.id) === byId("a1"))!;
        expect(info.scopeState).toBe(getScopeFormState(byId("a1")));
      }
      secret.value = "different";
      const before = getScopeFormState(byId("a1"));
      secret.value = "again";
      expect(getScopeFormState(byId("a1"))).toBe(before);
      // Values are already hidden by getSafeValue, so only a non-value attribute can show whether the control itself is excluded.
      secret.disabled = true;
      expect(getScopeFormState(byId("a1"))).toBe(before);
    });
  });

  it("rejects covered and replaced targets without heuristic remapping", async () => {
    const guarded = action();
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => document.body });
    expect(await executeAction(guarded)).toMatchObject({ ok: false, notExecuted: true, message: expect.stringContaining("covered") });
    document.querySelector("#search")!.outerHTML = '<button id="search">Search</button>';
    expect(await executeAction(guarded)).toMatchObject({ ok: false, notExecuted: true, message: expect.stringContaining("target") });
  });

  it("scrolls a target hidden by an inner panel or sticky bar into view and then clicks it once", async () => {
    const guarded = action();
    const target = document.querySelector("#search") as HTMLElement;
    let scrolled = false;
    const scrollIntoView = vi.fn(() => { scrolled = true; });
    Object.defineProperty(target, "scrollIntoView", { configurable: true, value: scrollIntoView });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => scrolled ? target : document.body });
    const click = vi.fn();
    target.addEventListener("click", click);
    expect((await executeAction(guarded)).ok).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "nearest", behavior: "instant" });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("names the covering element when scrolling does not uncover the target", async () => {
    document.body.insertAdjacentHTML("beforeend", '<div id="sticky-bar" class="footer fixed extra" role="toolbar">Submit   quiz</div>');
    const guarded = action();
    const click = vi.fn();
    document.querySelector("#search")!.addEventListener("click", click);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => document.querySelector("#sticky-bar") });
    expect(await executeAction(guarded)).toMatchObject({
      ok: false, notExecuted: true,
      message: 'The selected target is covered by <div#sticky-bar.footer.fixed role=toolbar> "Submit quiz" at (60, 25), even after scrolling it into view.',
    });
    expect(click).not.toHaveBeenCalled();
  });

  it.each(["radio", "checkbox"])("clicks a %s when its associated label covers the control", async (type) => {
    document.body.insertAdjacentHTML("beforeend", `<div><input id="answer" type="${type}" style="opacity:1" /><label for="answer" style="opacity:1"><span id="choice-text">Option A</span></label></div>`);
    const control = document.querySelector("#answer") as HTMLInputElement;
    const observation = observePage();
    const target = observation.elements.find((element) => element.type === type)!;
    expect(target).toBeDefined();
    const guarded = guardObservedAction({ type: "click", elementId: target.id }, observation)!;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => document.querySelector("#choice-text") });
    const clicks = vi.fn();
    control.addEventListener("click", clicks);
    expect((await executeAction(guarded)).ok).toBe(true);
    expect(control.checked).toBe(true);
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(await executeAction(guarded)).toMatchObject({ ok: false, notExecuted: true });
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it("uses the visible label when a radio's native input becomes transparent", async () => {
    document.body.insertAdjacentHTML("beforeend", '<label id="answer-label" style="opacity:1"><input id="answer" type="radio" style="opacity:1" /><span id="choice-text">Option A</span></label>');
    const control = document.querySelector("#answer") as HTMLInputElement;
    const observation = observePage();
    const target = observation.elements.find((element) => element.type === "radio")!;
    expect(target).toBeDefined();
    const guarded = guardObservedAction({ type: "click", elementId: target.id }, observation)!;
    control.style.opacity = "0";
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => document.querySelector("#choice-text") });
    expect((await executeAction(guarded)).ok).toBe(true);
    expect(control.checked).toBe(true);
  });

  it("does not mistake another radio's label for the selected radio's click surface", async () => {
    document.body.insertAdjacentHTML("beforeend", '<input id="answer" type="radio" name="choice" style="opacity:1" /><label for="answer">Option A</label><input id="other-answer" type="radio" name="choice" style="opacity:1" /><label for="other-answer"><span id="other-text">Option B</span></label>');
    const observation = observePage();
    const target = observation.elements.find((element) => element.type === "radio" && element.label?.includes("Option A"))!;
    expect(target).toBeDefined();
    const guarded = guardObservedAction({ type: "click", elementId: target.id }, observation)!;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => document.querySelector("#other-text") });
    expect(await executeAction(guarded)).toMatchObject({ ok: false, notExecuted: true, message: expect.stringContaining("covered") });
    expect((document.querySelector("#answer") as HTMLInputElement).checked).toBe(false);
    expect((document.querySelector("#other-answer") as HTMLInputElement).checked).toBe(false);
  });

  it.each(["PageUp", "PageDown"] as const)("%s scrolls the selected panel without moving focus", async (key) => {
    const container = document.createElement("div");
    container.scrollTop = 500;
    Object.defineProperties(container, {
      clientHeight: { value: 240 }, scrollHeight: { value: 2000 },
      scrollBy: { value: vi.fn((options: ScrollToOptions) => { container.scrollTop += options.top || 0; }) },
    });
    vi.spyOn(domMap, "getScrollContainer").mockReturnValue(container);
    const field = document.querySelector("#query") as HTMLInputElement;
    field.focus();
    const result = await executeAction({ type: "press_key", key });
    expect(result.ok).toBe(true);
    expect(container.scrollTop).toBe(key === "PageUp" ? 320 : 680);
    expect(result.message).toContain(key === "PageUp" ? "Scrolled up" : "Scrolled down");
    expect(document.activeElement).toBe(field);
  });

  it("does not substitute Tab for missing or unsupported keys", async () => {
    const field = document.querySelector("#query") as HTMLInputElement;
    field.focus();
    expect(await executeAction({ type: "press_key" })).toMatchObject({ ok: false, notExecuted: true });
    expect(await executeAction({ type: "press_key", text: "UnknownKey" })).toMatchObject({ ok: false, notExecuted: true });
    expect(document.activeElement).toBe(field);
  });

  it("keeps focus on an already-filled field instead of silently pressing Tab", async () => {
    const field = document.querySelector("#query") as HTMLInputElement;
    field.value = "existing answer";
    const observation = observePage();
    const element = observation.elements.find((entry) => entry.tag === "input")!;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => field });
    const guarded = guardObservedAction({ type: "fill", elementId: element.id, text: "replacement" }, observation)!;
    const result = await executeAction(guarded);
    expect(result.ok).toBe(true);
    expect(field.value).toBe("existing answer");
    expect(document.activeElement).toBe(field);
    expect(result.message).toContain("No automatic Tab");
  });

  describe("opt-in replacement of a filled field", () => {
    function setup(markup: string, value: string) {
      document.body.innerHTML = markup;
      const field = document.querySelector("input") as HTMLInputElement;
      field.value = value;
      Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => field });
      const observation = observePage();
      const element = observation.elements.find((entry) => entry.tag === "input")!;
      const guard = (replaceExisting: boolean, text = "new value") =>
        guardObservedAction({ type: "fill", elementId: element.id, text }, observation, { replaceExisting })!;
      return { field, element, guard };
    }

    it("replaces the value under an opt-in guard and reports it", async () => {
      const { field, guard } = setup('<input id="query" style="opacity:1" />', "old value");
      const guarded = guard(true);
      expect(guarded.guard?.replaceExisting).toBe(true);
      const result = await executeAction(guarded);
      expect(result).toMatchObject({ ok: true, message: expect.stringContaining("Replaced") });
      expect(field.value).toBe("new value");
    });

    it("keeps skipping a filled field without the opt-in", async () => {
      const { field, guard } = setup('<input id="query" style="opacity:1" />', "old value");
      const guarded = guard(false);
      expect(guarded.guard).not.toHaveProperty("replaceExisting");
      expect(await executeAction(guarded)).toMatchObject({ ok: true, message: expect.stringContaining("Skipped typing") });
      expect(field.value).toBe("old value");
    });

    it("never marks a sensitive field for replacement, and the page refuses a forged flag", async () => {
      const { field, guard } = setup('<input id="pw" type="password" style="opacity:1" />', "hunter2");
      const guarded = guard(true);
      expect(guarded.guard).not.toHaveProperty("replaceExisting");
      guarded.guard!.replaceExisting = true;
      expect(await executeAction(guarded)).toMatchObject({ ok: true, message: expect.stringContaining("Skipped typing") });
      expect(field.value).toBe("hunter2");
    });

    it("never overwrites a read-only field", async () => {
      const { field, guard } = setup('<input id="query" readonly style="opacity:1" />', "locked");
      const result = await executeAction(guard(true));
      expect(result.ok).toBe(false);
      expect(field.value).toBe("locked");
    });

    it("changes nothing when the field already holds the requested value", async () => {
      const { field, guard } = setup('<input id="query" style="opacity:1" />', "same");
      const changed = vi.fn();
      field.addEventListener("input", changed);
      expect(await executeAction(guard(true, "  same "))).toMatchObject({ ok: true, message: expect.stringContaining("already holds") });
      expect(changed).not.toHaveBeenCalled();
    });

    it("fails the action when the page does not keep the new value", async () => {
      const { field, guard } = setup('<input id="query" style="opacity:1" />', "old value");
      field.addEventListener("input", () => { field.value = "old value"; });
      expect(await executeAction(guard(true))).toMatchObject({ ok: false, recoverable: true, message: expect.stringContaining("did not keep") });
    });

    it("replaces a textarea the same way", async () => {
      document.body.innerHTML = '<textarea id="note" style="opacity:1">old note</textarea>';
      const area = document.querySelector("textarea") as HTMLTextAreaElement;
      Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => area });
      const observation = observePage();
      const target = observation.elements.find((entry) => entry.tag === "textarea")!;
      const result = await executeAction(guardObservedAction({ type: "fill", elementId: target.id, text: "new note" }, observation, { replaceExisting: true })!);
      expect(result.ok).toBe(true);
      expect(area.value).toBe("new note");
    });
  });

  it("scrolls a validated offscreen target into view before clicking", async () => {
    const guarded = action();
    const target = document.querySelector("#search") as HTMLElement;
    const inView = target.getBoundingClientRect();
    let visible = false;
    vi.spyOn(target, "getBoundingClientRect").mockImplementation(() => visible ? inView : { ...inView, top: 2000, bottom: 2030, y: 2000 });
    Object.defineProperty(target, "scrollIntoView", { configurable: true, value: vi.fn(() => { visible = true; }) });
    const click = vi.fn();
    target.addEventListener("click", click);
    expect((await executeAction(guarded)).ok).toBe(true);
    expect(visible).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
  });
});

describe("observation element cap", () => {
  beforeEach(() => {
    // Each button's rect top follows its DOM index, so viewport ordering matches document order.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const top = Number(this.getAttribute("data-top") ?? 0);
      return { x: 0, y: top, top, left: 0, right: 100, bottom: top + 20, width: 100, height: 20, toJSON() {} } as DOMRect;
    });
    document.body.innerHTML = Array.from({ length: 300 }, (_, index) => `<button data-top="${index}">Item ${index}</button>`).join("")
      + '<button data-top="900">Continue</button>';
  });

  afterEach(() => vi.restoreAllMocks());

  it("keeps the 80-element default and reports the full interactive count", () => {
    const observation = observePage();
    expect(observation.elements).toHaveLength(80);
    expect(observation.interactiveElementCount).toBe(301);
    expect(observation.elements.some((element) => element.text === "Continue")).toBe(false);
  });

  it("returns the same default for an invalid limit", () => {
    for (const invalid of [Number.NaN, 12.5, Number.POSITIVE_INFINITY]) expect(observePage(invalid).elements).toHaveLength(80);
  });

  it("allows up to 250 elements for a larger limit and never more", () => {
    expect(observePage(250).elements).toHaveLength(250);
    expect(observePage(10_000).elements).toHaveLength(250);
  });

  it("keeps a trailing Continue control when a larger limit overflows, without dropping earlier controls", () => {
    const observation = observePage(250);
    expect(observation.elements).toHaveLength(250);
    expect(observation.elements.some((element) => element.text === "Continue")).toBe(true);
    expect(observation.elements.slice(0, 200).map((element) => element.text)).toEqual(Array.from({ length: 200 }, (_, index) => `Item ${index}`));
    expect(observation.interactiveElementCount).toBe(301);
  });

  it("changes nothing when every control fits", () => {
    document.body.innerHTML = '<button data-top="0">One</button><button data-top="1">Continue</button>';
    expect(observePage(250).elements.map((element) => element.text)).toEqual(observePage().elements.map((element) => element.text));
  });
});

describe("question context extraction (golden)", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const top = Number(this.getAttribute("data-top") ?? 0);
      return { x: 0, y: top, top, left: 0, right: 100, bottom: top + 20, width: 100, height: 20, toJSON() {} } as DOMRect;
    });
  });

  afterEach(() => vi.restoreAllMocks());

  const problemPage = () => `<main>
    <section data-top="0"><h2>Problem Statement 1</h2> <p>Name the capital of France.</p> <input data-top="1" aria-label="Answer one" /></section>
    <section data-top="2"><h2>Problem Statement 2</h2> <p>Name the capital of Spain.</p> <input data-top="3" aria-label="Answer two" /></section>
  </main>`;

  it("still builds the nearest Problem Statement context and question number", () => {
    document.body.innerHTML = problemPage();
    const inputs = observePage().elements.filter((element) => element.tag === "input");
    expect(inputs.map((element) => element.context)).toEqual([
      "Problem Statement 1 Name the capital of France. Field: Answer one",
      "Problem Statement 2 Name the capital of Spain. Field: Answer two",
    ]);
    expect(inputs.map((element) => element.questionNumber)).toEqual(["1", "2"]);
  });

  it("builds no context and no question number on a page without Problem Statement text", () => {
    document.body.innerHTML = '<main><h2>Quiz</h2><p>Name the capital of France.</p><input data-top="1" aria-label="Answer one" /><label data-top="2">Choice <input type="radio" data-top="3" /></label></main>';
    const elements = observePage().elements;
    expect(elements.length).toBeGreaterThan(1);
    for (const element of elements) {
      expect(element.context).toBeUndefined();
      expect(element.questionNumber).toBeUndefined();
    }
  });

  it("reads page text changes made between observations, with no stale skip decision", () => {
    document.body.innerHTML = '<main><p>Plain page.</p><input data-top="1" aria-label="Answer" /></main>';
    expect(observePage().elements.find((element) => element.tag === "input")?.context).toBeUndefined();
    document.body.innerHTML = '<main><h2>Problem Statement 9</h2><input data-top="1" aria-label="Answer" /></main>';
    expect(observePage().elements.find((element) => element.tag === "input")?.context).toBe("Problem Statement 9 Field: Answer");
    document.body.innerHTML = '<main><p>Plain again.</p><input data-top="1" aria-label="Answer" /></main>';
    expect(observePage().elements.find((element) => element.tag === "input")?.context).toBeUndefined();
  });

  it("re-reads the same page after its text changes in place", () => {
    document.body.innerHTML = '<main><p id="heading">Plain page.</p> <input data-top="1" aria-label="Answer" /></main>';
    const heading = document.querySelector("#heading") as HTMLElement;
    expect(observePage().elements.find((element) => element.tag === "input")?.context).toBeUndefined();
    heading.textContent = "Problem Statement 6";
    expect(observePage().elements.find((element) => element.tag === "input")?.context).toBe("Problem Statement 6 Field: Answer");
    heading.textContent = "Plain once more.";
    expect(observePage().elements.find((element) => element.tag === "input")?.context).toBeUndefined();
  });

  it("only attributes Problem Statement text that appears before the control", () => {
    document.body.innerHTML = '<main><input data-top="1" aria-label="Early" /><h2>Problem Statement 3</h2><input data-top="2" aria-label="Late" /></main>';
    const inputs = observePage().elements.filter((element) => element.tag === "input");
    expect(inputs.map((element) => element.context)).toEqual([undefined, "Problem Statement 3 Field: Late"]);
  });

  it("clears its scoped cache even when a read throws inside the observation", () => {
    document.body.innerHTML = '<main><h2>Problem Statement 4</h2> <input data-top="1" aria-label="Answer" /></main>';
    const original = Range.prototype.toString;
    Range.prototype.toString = () => { throw new Error("boom"); };
    // The range read has its own fallback, so the throw is absorbed; the point is the cache is gone afterwards either way.
    try { observePage(); } finally { Range.prototype.toString = original; }
    document.body.innerHTML = '<main><p>Plain page now.</p> <input data-top="1" aria-label="Answer" /></main>';
    expect(observePage().elements.find((element) => element.tag === "input")?.context).toBeUndefined();
    document.body.innerHTML = '<main><h2>Problem Statement 5</h2> <input data-top="1" aria-label="Answer" /></main>';
    expect(observePage().elements.find((element) => element.tag === "input")?.context).toBe("Problem Statement 5 Field: Answer");
  });
});
describe("choice group summary", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const hidden = this.hasAttribute("data-hidden");
      return { x: 0, y: 0, top: 0, left: 0, right: hidden ? 0 : 100, bottom: hidden ? 0 : 20, width: hidden ? 0 : 100, height: hidden ? 0 : 20, toJSON() {} } as DOMRect;
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("omits the field when the page has no radio groups, even with checkboxes", () => {
    document.body.innerHTML = '<input type="checkbox" name="a"><button>Go</button>';
    expect(observePage()).not.toHaveProperty("choiceGroups");
  });

  it("counts groups by name and how many have no selection", () => {
    document.body.innerHTML = '<input type="radio" name="q1" checked><input type="radio" name="q1"><input type="radio" name="q2"><input type="radio" name="q2"><input type="radio" name="q3"><input type="radio" name="q3" checked>';
    expect(observePage().choiceGroups).toEqual({ total: 3, unanswered: 1 });
  });

  it("keeps same-named radios in different forms as separate groups", () => {
    document.body.innerHTML = '<form><input type="radio" name="q" checked></form><form><input type="radio" name="q"></form>';
    expect(observePage().choiceGroups).toEqual({ total: 2, unanswered: 1 });
  });

  it("ignores unnamed, disabled and fully hidden groups but counts a hidden input with a visible label", () => {
    document.body.innerHTML = '<input type="radio"><input type="radio" name="d" disabled><input type="radio" name="h" data-hidden><input type="radio" id="styled" name="s" data-hidden><label for="styled">Styled</label>';
    expect(observePage().choiceGroups).toEqual({ total: 1, unanswered: 1 });
  });

  it("counts ARIA radio groups by their selected option", () => {
    document.body.innerHTML = '<div role="radiogroup"><div role="radio" aria-checked="true">A</div><div role="radio" aria-checked="false">B</div></div>'
      + '<div role="radiogroup"><div role="radio" aria-checked="false">A</div><div role="radio" aria-checked="false">B</div></div>';
    expect(observePage().choiceGroups).toEqual({ total: 2, unanswered: 1 });
  });

  it("treats an ARIA option without a checked state as unselected and skips hidden or empty groups", () => {
    document.body.innerHTML = '<div role="radiogroup"><div role="radio">A</div><div role="radio">B</div></div>'
      + '<div role="radiogroup" data-hidden><div role="radio" aria-checked="false">A</div></div>'
      + '<div role="radiogroup"></div>';
    expect(observePage().choiceGroups).toEqual({ total: 1, unanswered: 1 });
  });
});
