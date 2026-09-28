// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkWaitCondition, getDocumentId, getElementFingerprint, getFormStateFingerprint, isSensitiveElement, observePage } from "./domMap";
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

  it("rejects changed form values even outside the target's parent", async () => {
    const guarded = action();
    const before = getFormStateFingerprint();
    (document.querySelector("#query") as HTMLInputElement).value = "changed";
    expect(getFormStateFingerprint()).not.toBe(before);
    expect(await executeAction(guarded)).toMatchObject({ ok: false, notExecuted: true, message: expect.stringContaining("Form values changed") });
  });

  it("rejects covered and replaced targets without heuristic remapping", async () => {
    const guarded = action();
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => document.body });
    expect(await executeAction(guarded)).toMatchObject({ ok: false, notExecuted: true, message: expect.stringContaining("covered") });
    document.querySelector("#search")!.outerHTML = '<button id="search">Search</button>';
    expect(await executeAction(guarded)).toMatchObject({ ok: false, notExecuted: true, message: expect.stringContaining("target") });
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