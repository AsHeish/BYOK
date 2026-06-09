import { extractPageData, getMappedElement, observePage } from "./domMap";
import type { AgentAction, ContentActionResult } from "../shared/types";

type ElementLookup = { ok: true; value: HTMLElement } | { ok: false; message: string };
type TextEditableElement = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

const textEditableSelector = [
  "input:not([type='hidden']):not([type='button']):not([type='submit']):not([type='reset']):not([type='checkbox']):not([type='radio']):not([type='file'])",
  "textarea",
  "[contenteditable='true']"
].join(",");

const keyboardFocusableSelector = [
  textEditableSelector,
  "select:not([disabled])",
  "button:not([disabled])",
  "a[href]",
  "[role='button']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[role='combobox']",
  "[role='textbox']",
  "[tabindex]:not([tabindex='-1'])",
  ".MuiInputBase-root",
  ".MuiOutlinedInput-root",
  ".MuiFilledInput-root",
  ".MuiFormControl-root",
  ".MuiAutocomplete-root",
  ".MuiSelect-root"
].join(",");

export async function executeAction(action: AgentAction): Promise<ContentActionResult> {
  switch (action.type) {
    case "click":
      return withFreshObservation(clickElement(action.elementId));

    case "drag":
      return withFreshObservation(dragElementToTarget(action.elementId, action.targetElementId));

    case "fill":
    case "type":
      return withFreshObservation(typeIntoElement(action.elementId, action.text || ""));

    case "select":
      return withFreshObservation(selectOption(action.elementId, action.text || ""));

    case "press_key":
      return withFreshObservation(pressKey(action.key || action.text || "Tab", action.elementId));

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

async function withFreshObservation(
  resultOrPromise: ContentActionResult | Promise<ContentActionResult>
): Promise<ContentActionResult> {
  const result = await resultOrPromise;
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

async function dragElementToTarget(
  sourceElementId: string | undefined,
  targetElementId: string | undefined
): Promise<ContentActionResult> {
  const sourceLookup = requireElement(sourceElementId);
  if (!sourceLookup.ok) {
    return sourceLookup;
  }

  const targetLookup = requireElement(targetElementId);
  if (!targetLookup.ok) {
    return targetLookup;
  }

  const source = sourceLookup.value;
  const target = targetLookup.value;

  prepareElement(source);
  await sleep(80);
  const startPoint = getElementCenter(source);
  const dataTransfer = createDragDataTransfer(source);

  dispatchPointerDragEvent(source, "pointerdown", startPoint, true);
  dispatchMouseDragEvent(source, "mousedown", startPoint, true);
  dispatchDragEvent(source, "dragstart", dataTransfer, startPoint);

  prepareElement(target);
  await sleep(80);
  const endPoint = getElementCenter(target);

  for (const point of interpolatePoints(startPoint, endPoint, 8)) {
    const hoverTarget = getElementAtPoint(point) || target;
    dispatchPointerDragEvent(hoverTarget, "pointermove", point, true);
    dispatchMouseDragEvent(hoverTarget, "mousemove", point, true);
    dispatchDragEvent(hoverTarget, "dragover", dataTransfer, point);
    await sleep(18);
  }

  dispatchDragEvent(target, "dragenter", dataTransfer, endPoint);
  dispatchDragEvent(target, "dragover", dataTransfer, endPoint);
  dispatchDragEvent(target, "drop", dataTransfer, endPoint);
  dispatchMouseDragEvent(target, "mouseup", endPoint, false);
  dispatchPointerDragEvent(target, "pointerup", endPoint, false);
  dispatchDragEvent(source, "dragend", dataTransfer, endPoint);

  return {
    ok: true,
    message: `Dragged ${describeElement(source)} to ${describeElement(target)}.`
  };
}

async function typeIntoElement(elementId: string | undefined, text: string): Promise<ContentActionResult> {
  const lookup = requireElement(elementId);
  if (!lookup.ok) {
    return lookup;
  }

  const element = lookup.value;
  const editable = await resolveTextEditableTarget(element);

  if (!editable) {
    return {
      ok: false,
      message: "The target element is not editable and no nested editable field became active."
    };
  }

  prepareElement(editable);

  if (editable instanceof HTMLInputElement) {
    if (hasExistingEditableValue(editable)) {
      return skipAlreadyFilledField(editable);
    }
    setNativeValue(editable, text);
    dispatchFormEvents(editable);
    return {
      ok: true,
      message: `Typed into ${describeElement(editable)}.`
    };
  }

  if (editable instanceof HTMLTextAreaElement) {
    if (hasExistingEditableValue(editable)) {
      return skipAlreadyFilledField(editable);
    }
    setNativeValue(editable, text);
    dispatchFormEvents(editable);
    return {
      ok: true,
      message: `Typed into ${describeElement(editable)}.`
    };
  }

  if (editable.isContentEditable) {
    if (hasExistingEditableValue(editable)) {
      return skipAlreadyFilledField(editable);
    }
    editable.textContent = text;
    dispatchInputEvent(editable);
    return {
      ok: true,
      message: `Typed into ${describeElement(editable)}.`
    };
  }

  return {
    ok: false,
    message: "The target element is not editable."
  };
}

async function resolveTextEditableTarget(element: HTMLElement): Promise<TextEditableElement | undefined> {
  const initialTarget = getTextEditableElement(element) || findNestedTextEditable(element);
  const activationTarget = getEditableActivationTarget(element, initialTarget);

  if (activationTarget) {
    activateForTyping(activationTarget);
    await sleep(90);
  }

  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  if (activeElement) {
    const activeEditable = getTextEditableElement(activeElement) || findNestedTextEditable(activeElement);
    if (activeEditable && (element.contains(activeEditable) || activeEditable === initialTarget)) {
      return activeEditable;
    }
  }

  return initialTarget || findNestedTextEditable(element);
}

function getTextEditableElement(element: HTMLElement): TextEditableElement | undefined {
  if (element instanceof HTMLInputElement && isTextEntryInput(element)) {
    return element;
  }

  if (element instanceof HTMLTextAreaElement) {
    return element;
  }

  if (element.isContentEditable) {
    return element;
  }

  return undefined;
}

function hasExistingEditableValue(element: TextEditableElement): boolean {
  const currentValue = getEditableValue(element);
  return normalizeTypedValue(currentValue).length > 0;
}

function getEditableValue(element: TextEditableElement): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value;
  }

  return element.textContent || "";
}

function normalizeTypedValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function skipAlreadyFilledField(editable: TextEditableElement): ContentActionResult {
  const nextElement = focusAdjacentElement(false);
  const advanceMessage = nextElement ? ` Focused next field ${describeElement(nextElement)}.` : "";

  return {
    ok: true,
    message: `Skipped typing because ${describeElement(editable)} already has a value.${advanceMessage}`
  };
}

function findNestedTextEditable(element: HTMLElement): TextEditableElement | undefined {
  const nested = element.querySelector<HTMLElement>(textEditableSelector);
  return nested ? getTextEditableElement(nested) : undefined;
}

function getEditableActivationTarget(
  originalElement: HTMLElement,
  editable?: TextEditableElement
): HTMLElement | undefined {
  const labelControl = originalElement instanceof HTMLLabelElement ? originalElement.control : undefined;
  if (labelControl instanceof HTMLElement) {
    return originalElement;
  }

  const wrapper = editable ? findLikelyEditableWrapper(editable, originalElement) : undefined;
  if (wrapper) {
    return wrapper;
  }

  return originalElement;
}

function findLikelyEditableWrapper(editable: HTMLElement, boundary: HTMLElement): HTMLElement | undefined {
  let current = editable.parentElement;
  let depth = 0;

  while (current && current !== document.body && depth < 5) {
    if (current === boundary || current.contains(boundary) || boundary.contains(current)) {
      if (isLikelyEditableWrapper(current)) {
        return current;
      }
    }
    current = current.parentElement;
    depth += 1;
  }

  return boundary === editable ? undefined : boundary;
}

function isLikelyEditableWrapper(element: HTMLElement): boolean {
  const className = String(element.getAttribute("class") || "");
  const role = element.getAttribute("role") || "";
  return (
    element instanceof HTMLLabelElement ||
    role === "textbox" ||
    role === "combobox" ||
    element.tabIndex >= 0 ||
    element.hasAttribute("onclick") ||
    /InputBase|OutlinedInput|FilledInput|FormControl|Autocomplete|Select|TextField|field|input|control/i.test(className)
  );
}

function activateForTyping(element: HTMLElement): void {
  prepareElement(element);
  dispatchPointerSequence(element);
  element.click();
}

function isTextEntryInput(element: HTMLInputElement): boolean {
  return !["button", "submit", "reset", "checkbox", "radio", "file", "hidden"].includes(element.type);
}

async function pressKey(key: string, startingElementId?: string): Promise<ContentActionResult> {
  const normalizedKey = normalizeSupportedKey(key);
  if (!normalizedKey) {
    return {
      ok: false,
      message: "Only Tab and Shift+Tab key actions are supported."
    };
  }

  const startingElementResult = focusStartingElement(startingElementId);
  if (!startingElementResult.ok) {
    return startingElementResult;
  }

  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  dispatchKeyboardEvent(activeElement, "keydown", normalizedKey);

  const target = focusAdjacentElement(normalizedKey === "Shift+Tab");
  if (!target) {
    dispatchKeyboardEvent(activeElement, "keyup", normalizedKey);
    return {
      ok: false,
      message: "No next focusable element was found."
    };
  }

  dispatchKeyboardEvent(target, "keyup", normalizedKey);
  return {
    ok: true,
    message: normalizedKey === "Shift+Tab" ? `Focused previous field ${describeElement(target)}.` : `Focused next field ${describeElement(target)}.`
  };
}

function focusStartingElement(elementId?: string): ContentActionResult {
  if (!elementId) {
    return {
      ok: true,
      message: "Using current focused element."
    };
  }

  const lookup = requireElement(elementId);
  if (!lookup.ok) {
    return lookup;
  }

  const focusTarget = getKeyboardFocusTarget(lookup.value) || lookup.value;
  prepareElement(focusTarget);
  return {
    ok: true,
    message: `Focused ${describeElement(focusTarget)} before key press.`
  };
}

function normalizeSupportedKey(key: string): "Tab" | "Shift+Tab" | undefined {
  const normalized = key.trim().toLowerCase().replace(/\s+/g, "");
  if (normalized === "tab") {
    return "Tab";
  }
  if (normalized === "shift+tab" || normalized === "shifttab") {
    return "Shift+Tab";
  }
  return undefined;
}

function focusAdjacentElement(reverse: boolean): HTMLElement | undefined {
  const focusableElements = getKeyboardFocusableElements();
  if (focusableElements.length === 0) {
    return undefined;
  }

  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const currentIndex = activeElement
    ? focusableElements.findIndex(
        (element) => element === activeElement || element.contains(activeElement) || activeElement.contains(element)
      )
    : -1;

  const fallbackIndex = reverse ? focusableElements.length : -1;
  const fromIndex = currentIndex >= 0 ? currentIndex : fallbackIndex;
  const nextIndex = reverse
    ? (fromIndex - 1 + focusableElements.length) % focusableElements.length
    : (fromIndex + 1) % focusableElements.length;
  const nextElement = focusableElements[nextIndex];

  prepareElement(nextElement);
  return nextElement;
}

function getKeyboardFocusableElements(): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  const focusableElements: HTMLElement[] = [];

  for (const element of Array.from(document.querySelectorAll<HTMLElement>(keyboardFocusableSelector))) {
    const focusTarget = getKeyboardFocusTarget(element);
    if (!focusTarget || seen.has(focusTarget) || isDisabled(focusTarget) || !isVisibleElement(focusTarget)) {
      continue;
    }
    seen.add(focusTarget);
    focusableElements.push(focusTarget);
  }

  return focusableElements;
}

function getKeyboardFocusTarget(element: HTMLElement): HTMLElement | undefined {
  const textEditable = getTextEditableElement(element) || findNestedTextEditable(element);
  if (textEditable) {
    return textEditable;
  }

  if (element instanceof HTMLSelectElement || element instanceof HTMLButtonElement || element instanceof HTMLAnchorElement) {
    return element;
  }

  if (element.tabIndex >= 0 || element.hasAttribute("role")) {
    return element;
  }

  return undefined;
}

function dispatchKeyboardEvent(element: HTMLElement, type: "keydown" | "keyup", key: "Tab" | "Shift+Tab"): void {
  const isShiftTab = key === "Shift+Tab";
  element.dispatchEvent(
    new KeyboardEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      key: "Tab",
      code: "Tab",
      keyCode: 9,
      which: 9,
      shiftKey: isShiftTab
    })
  );
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

function createDragDataTransfer(source: HTMLElement): DataTransfer {
  const dataTransfer = new DataTransfer();
  const text = source.innerText?.trim() || source.textContent?.trim() || source.getAttribute("aria-label") || source.id || "dragged item";
  dataTransfer.effectAllowed = "move";
  dataTransfer.dropEffect = "move";
  dataTransfer.setData("text/plain", text);
  dataTransfer.setData("text", text);
  return dataTransfer;
}

function getElementCenter(element: HTMLElement): { clientX: number; clientY: number } {
  const rect = element.getBoundingClientRect();
  return {
    clientX: rect.left + Math.max(1, rect.width / 2),
    clientY: rect.top + Math.max(1, rect.height / 2)
  };
}

function interpolatePoints(
  start: { clientX: number; clientY: number },
  end: { clientX: number; clientY: number },
  steps: number
): Array<{ clientX: number; clientY: number }> {
  return Array.from({ length: steps }, (_, index) => {
    const ratio = (index + 1) / steps;
    return {
      clientX: start.clientX + (end.clientX - start.clientX) * ratio,
      clientY: start.clientY + (end.clientY - start.clientY) * ratio
    };
  });
}

function getElementAtPoint(point: { clientX: number; clientY: number }): HTMLElement | undefined {
  const element = document.elementFromPoint(point.clientX, point.clientY);
  return element instanceof HTMLElement ? element : undefined;
}

function dispatchDragEvent(
  element: HTMLElement,
  type: "dragstart" | "dragenter" | "dragover" | "drop" | "dragend",
  dataTransfer: DataTransfer,
  point: { clientX: number; clientY: number }
): void {
  element.dispatchEvent(
    new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: point.clientX,
      clientY: point.clientY,
      dataTransfer
    })
  );
}

function dispatchPointerDragEvent(
  element: HTMLElement,
  type: "pointerdown" | "pointermove" | "pointerup",
  point: { clientX: number; clientY: number },
  isDragging: boolean
): void {
  element.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      clientX: point.clientX,
      clientY: point.clientY,
      button: 0,
      buttons: isDragging ? 1 : 0,
      view: window
    })
  );
}

function dispatchMouseDragEvent(
  element: HTMLElement,
  type: "mousedown" | "mousemove" | "mouseup",
  point: { clientX: number; clientY: number },
  isDragging: boolean
): void {
  element.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: point.clientX,
      clientY: point.clientY,
      button: 0,
      buttons: isDragging ? 1 : 0,
      view: window
    })
  );
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

function isVisibleElement(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
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

  if (findNestedTextEditable(element) && isLikelyEditableWrapper(element)) {
    return element;
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
