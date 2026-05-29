import { extractPageData, getMappedElement, isSensitiveElement, observePage } from "./domMap";
import type { AgentAction, ContentActionResult } from "../shared/types";

type ElementLookup = { ok: true; value: HTMLElement } | { ok: false; message: string };

export async function executeAction(action: AgentAction): Promise<ContentActionResult> {
  switch (action.type) {
    case "click":
      return withFreshObservation(clickElement(action.elementId));

    case "type":
      return withFreshObservation(typeIntoElement(action.elementId, action.text || ""));

    case "select":
      return withFreshObservation(selectOption(action.elementId, action.text || ""));

    case "scroll":
      return withFreshObservation(scrollPage(action.direction || "down"));

    case "navigate":
      return navigateTo(action.url);

    case "extract":
      return {
        ok: true,
        message: "Extracted structured page data.",
        data: extractPageData(),
        observation: observePage()
      };

    case "ask_user":
    case "done":
      return {
        ok: true,
        message: action.text || action.type,
        observation: observePage()
      };

    default:
      return {
        ok: false,
        message: `Unsupported action: ${(action as AgentAction).type}`
      };
  }
}

async function withFreshObservation(result: ContentActionResult): Promise<ContentActionResult> {
  if (!result.ok) {
    return result;
  }

  await sleep(120);
  return {
    ...result,
    observation: observePage()
  };
}

function clickElement(elementId?: string): ContentActionResult {
  const lookup = requireElement(elementId);
  if (!lookup.ok) {
    return lookup;
  }

  const element = lookup.value;
  activateElement(element);

  return {
    ok: true,
    message: `Clicked ${describeElement(element)}.`
  };
}

function typeIntoElement(elementId: string | undefined, text: string): ContentActionResult {
  const lookup = requireElement(elementId);
  if (!lookup.ok) {
    return lookup;
  }

  const element = lookup.value;

  if (isSensitiveElement(element)) {
    // The background also validates this, but content scripts enforce it at the final trust boundary.
    return {
      ok: false,
      message: "Refusing to type into a sensitive field."
    };
  }

  prepareElement(element);

  if (element instanceof HTMLInputElement) {
    if (element.type === "file") {
      return {
        ok: false,
        message: "File inputs are not supported."
      };
    }
    setNativeValue(element, text);
    dispatchFormEvents(element);
    return {
      ok: true,
      message: `Typed into ${describeElement(element)}.`
    };
  }

  if (element instanceof HTMLTextAreaElement) {
    setNativeValue(element, text);
    dispatchFormEvents(element);
    return {
      ok: true,
      message: `Typed into ${describeElement(element)}.`
    };
  }

  if (element.isContentEditable) {
    element.textContent = text;
    dispatchInputEvent(element);
    return {
      ok: true,
      message: `Typed into ${describeElement(element)}.`
    };
  }

  return {
    ok: false,
    message: "The target element is not editable."
  };
}

function selectOption(elementId: string | undefined, text: string): ContentActionResult {
  const lookup = requireElement(elementId);
  if (!lookup.ok) {
    return lookup;
  }

  const element = lookup.value;

  if (!(element instanceof HTMLSelectElement)) {
    return {
      ok: false,
      message: "The target element is not a select control."
    };
  }

  const option = Array.from(element.options).find(
    (candidate) =>
      candidate.value === text ||
      candidate.text.trim() === text ||
      candidate.label.trim() === text ||
      candidate.text.trim().toLowerCase() === text.toLowerCase()
  );

  if (!option) {
    return {
      ok: false,
      message: `Could not find select option "${text}".`
    };
  }

  setNativeValue(element, option.value);
  dispatchFormEvents(element);
  return {
    ok: true,
    message: `Selected ${option.text || option.value}.`
  };
}

function scrollPage(direction: NonNullable<AgentAction["direction"]>): ContentActionResult {
  const amount = Math.max(320, Math.floor(window.innerHeight * 0.75));
  const delta = {
    up: { top: -amount, left: 0 },
    down: { top: amount, left: 0 },
    left: { top: 0, left: -amount },
    right: { top: 0, left: amount }
  }[direction];

  window.scrollBy({ ...delta, behavior: "smooth" });
  return {
    ok: true,
    message: `Scrolled ${direction}.`
  };
}

function navigateTo(url?: string): ContentActionResult {
  if (!url) {
    return {
      ok: false,
      message: "Navigate action requires a URL."
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url, location.href);
  } catch {
    return {
      ok: false,
      message: "Navigate action URL is invalid."
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      message: "The agent can only navigate to http(s) URLs."
    };
  }

  location.assign(parsed.toString());
  return {
    ok: true,
    message: `Navigating to ${parsed.toString()}.`
  };
}

function requireElement(elementId?: string): ElementLookup {
  if (!elementId) {
    return {
      ok: false,
      message: "Action requires an elementId."
    };
  }

  const element = getMappedElement(elementId);
  if (!element || !document.documentElement.contains(element)) {
    return {
      ok: false,
      message: "The target element is no longer available."
    };
  }

  if (isDisabled(element)) {
    return {
      ok: false,
      message: "The target element is disabled."
    };
  }

  return { ok: true, value: element };
}

function isDisabled(element: HTMLElement): boolean {
  if (
    element instanceof HTMLButtonElement ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return element.disabled;
  }

  return element.getAttribute("aria-disabled") === "true";
}

function describeElement(element: HTMLElement): string {
  const label =
    element.getAttribute("aria-label") ||
    element.getAttribute("name") ||
    element.textContent?.trim().slice(0, 40) ||
    element.tagName.toLowerCase();
  return `"${label}"`;
}

function activateElement(element: HTMLElement): void {
  const target = getBestActivationTarget(element);
  prepareElement(target);

  if (target instanceof HTMLInputElement && (target.type === "checkbox" || target.type === "radio")) {
    dispatchPointerSequence(target);
    target.click();
    setNativeChecked(target, true);
    dispatchFormEvents(target);
    return;
  }

  dispatchPointerSequence(target);
  target.click();
}

function getBestActivationTarget(element: HTMLElement): HTMLElement {
  if (element instanceof HTMLLabelElement && element.control instanceof HTMLElement) {
    return element.control;
  }

  const labelledControl = element.querySelector<HTMLElement>("input,button,select,textarea,[role='radio'],[role='checkbox']");
  if (labelledControl) {
    return labelledControl;
  }

  return element;
}

function prepareElement(element: HTMLElement): void {
  element.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
  element.focus({ preventScroll: true });
}

function dispatchPointerSequence(element: HTMLElement): void {
  const rect = element.getBoundingClientRect();
  const clientX = rect.left + Math.max(1, rect.width / 2);
  const clientY = rect.top + Math.max(1, rect.height / 2);
  const eventInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX,
    clientY,
    button: 0,
    buttons: 1,
    view: window
  };

  element.dispatchEvent(new PointerEvent("pointerdown", eventInit));
  element.dispatchEvent(new MouseEvent("mousedown", eventInit));
  element.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, buttons: 0 }));
  element.dispatchEvent(new MouseEvent("mouseup", { ...eventInit, buttons: 0 }));
}

function dispatchFormEvents(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): void {
  dispatchInputEvent(element);
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function dispatchInputEvent(element: HTMLElement): void {
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  descriptor?.set?.call(element, value);
}

function setNativeChecked(element: HTMLInputElement, checked: boolean): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
  descriptor?.set?.call(element, checked);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
