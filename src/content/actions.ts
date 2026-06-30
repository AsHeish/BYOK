import { extractPageData, findMappedElementReplacement, getMappedElement, observePage } from "./domMap";
import { stagedFileToBrowserFile } from "../shared/fileData";
import { loadStagedUploadFile } from "../shared/storage";
import type { AgentAction, ContentActionResult } from "../shared/types";

type ElementLookup = { ok: true; value: HTMLElement } | { ok: false; message: string; recoverable?: boolean };
type TextEditableElement = HTMLInputElement | HTMLTextAreaElement | HTMLElement;
type HtmlConstructorName =
  | "HTMLElement"
  | "HTMLInputElement"
  | "HTMLTextAreaElement"
  | "HTMLSelectElement"
  | "HTMLButtonElement"
  | "HTMLAnchorElement"
  | "HTMLLabelElement";

type QueryRoot = Document | ShadowRoot;

const textEditableSelector = [
  "input:not([type='hidden']):not([type='button']):not([type='submit']):not([type='reset']):not([type='checkbox']):not([type='radio']):not([type='file'])",
  "textarea",
  "[contenteditable='true']"
].join(",");

const fileInputSelector = "input[type='file']";

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

const editableContextSelector = [
  "form",
  "[role='form']",
  "label",
  "[class*='question']",
  "[class*='Question']",
  "[class*='problem']",
  "[class*='Problem']",
  "[class*='answer']",
  "[class*='Answer']",
  ".MuiFormControl-root",
  ".MuiInputBase-root",
  ".MuiOutlinedInput-root",
  ".MuiFilledInput-root",
  ".MuiAutocomplete-root"
].join(",");

export async function executeAction(action: AgentAction): Promise<ContentActionResult> {
  switch (action.type) {
    case "click":
      return withFreshObservation(clickElement(action.elementId));

    case "multi_click":
      return withFreshObservation(clickMultipleElements(action.elementIds));

    case "drag":
      return withFreshObservation(dragElementToTarget(action.elementId, action.targetElementId));

    case "multi_drag":
      return withFreshObservation(dragMultipleElementsToTargets(action.dragPairs));

    case "upload_file":
      return withFreshObservation(uploadStagedFile(action.elementId, action.fileId));

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
    if (result.recoverable) {
      return {
        ...result,
        observation: observePage()
      };
    }
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

async function clickMultipleElements(elementIds?: string[]): Promise<ContentActionResult> {
  const uniqueElementIds = Array.from(new Set(elementIds || [])).filter(Boolean);
  if (uniqueElementIds.length === 0) {
    return {
      ok: false,
      message: "multi_click requires at least one elementId in elementIds."
    };
  }

  const elements: HTMLElement[] = [];
  for (const elementId of uniqueElementIds) {
    const lookup = requireElement(elementId);
    if (!lookup.ok) {
      return {
        ok: false,
        recoverable: lookup.recoverable,
        message: `Could not multi-click ${elementId}: ${lookup.message}`
      };
    }
    elements.push(lookup.value);
  }

  const clicked: string[] = [];
  const skipped: string[] = [];
  for (const element of elements) {
    const target = getBestActivationTarget(element);
    if (isAlreadySelectedChoice(target)) {
      skipped.push(describeElement(target));
      continue;
    }

    activateElement(element);
    clicked.push(describeElement(target));
    await sleep(80);
  }

  const skippedMessage = skipped.length ? ` Skipped already selected: ${skipped.join(", ")}.` : "";
  return {
    ok: true,
    message: `Selected ${clicked.length} option${clicked.length === 1 ? "" : "s"}: ${clicked.join(", ") || "none"}.${skippedMessage}`
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
    const hoverTarget = getElementAtPoint(point, source.ownerDocument) || target;
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

async function dragMultipleElementsToTargets(
  dragPairs: AgentAction["dragPairs"]
): Promise<ContentActionResult> {
  if (!dragPairs?.length) {
    return {
      ok: false,
      message: "multi_drag requires at least one drag pair."
    };
  }

  const completed: string[] = [];
  for (let index = 0; index < dragPairs.length; index += 1) {
    const pair = dragPairs[index];
    const result = await dragElementToTarget(pair.elementId, pair.targetElementId);
    if (!result.ok) {
      return {
        ok: false,
        recoverable: result.recoverable,
        message: `Could not finish multi_drag pair ${index + 1}: ${result.message}`
      };
    }

    completed.push(result.message.replace(/\.$/, ""));
    await sleep(140);
  }

  return {
    ok: true,
    message: `Completed ${completed.length} drag/drop action${completed.length === 1 ? "" : "s"}: ${completed.join("; ")}.`
  };
}

async function uploadStagedFile(elementId: string | undefined, fileId: string | undefined): Promise<ContentActionResult> {
  const stagedFile = await loadStagedUploadFile();
  if (!stagedFile) {
    return {
      ok: false,
      recoverable: true,
      message: "No staged upload file is available. Choose a file in the side panel before using upload_file."
    };
  }

  if (fileId && stagedFile.id !== fileId) {
    return {
      ok: false,
      recoverable: true,
      message: `The requested staged file ${fileId} is not available. Current staged file is ${stagedFile.id} (${stagedFile.name}).`
    };
  }

  const lookup = elementId ? requireElement(elementId) : findFirstAvailableFileInput();
  if (!lookup.ok) {
    return lookup;
  }

  const fileInput = findFileInputTarget(lookup.value);
  if (!fileInput) {
    return {
      ok: false,
      recoverable: true,
      message: "Could not find a file input related to the target element. Pick a visible upload button/label or input[type=file]."
    };
  }

  if (fileInput.disabled) {
    return {
      ok: false,
      recoverable: true,
      message: "The target file input is disabled."
    };
  }

  const file = stagedFileToBrowserFile(stagedFile);
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  fileInput.files = dataTransfer.files;
  dispatchInputEvent(fileInput);
  fileInput.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

  return {
    ok: true,
    message: `Uploaded staged file "${stagedFile.name}" into ${describeElement(fileInput)}.`
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
      recoverable: true,
      message:
        "The target element is not editable and no related editable field became active. Refreshed the page context; choose a visible empty fillable control, the focused editable field, or click the wrapper before filling."
    };
  }

  prepareElement(editable);

  if (isInputElement(editable)) {
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

  if (isTextAreaElement(editable)) {
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
    recoverable: true,
    message:
      "The resolved target is not editable. Refreshed the page context; choose a current visible empty fillable control next."
  };
}

async function resolveTextEditableTarget(element: HTMLElement): Promise<TextEditableElement | undefined> {
  const activeBefore = getDeepActiveElement(element.ownerDocument);
  const initialTarget =
    getTextEditableElement(element) ||
    getAssociatedTextEditable(element) ||
    findNestedTextEditable(element) ||
    findNearbyTextEditable(element);

  for (const activationTarget of getEditableActivationTargets(element, initialTarget)) {
    activateForTyping(activationTarget);

    const activeEditable = await waitForActiveTextEditable(element, activeBefore, initialTarget, 260);
    if (activeEditable) {
      return activeEditable;
    }

    const currentTarget =
      getTextEditableElement(element) ||
      getAssociatedTextEditable(element) ||
      findNestedTextEditable(element) ||
      findNearbyTextEditable(element);
    if (currentTarget) {
      return currentTarget;
    }
  }

  const activeEditable = getActiveTextEditable(element.ownerDocument);
  if (activeEditable && isLikelyEditableForTarget(element, activeEditable, activeBefore, initialTarget)) {
    return activeEditable;
  }

  return initialTarget || findNearbyTextEditable(element);
}

function getTextEditableElement(element: HTMLElement): TextEditableElement | undefined {
  if (!isVisibleElement(element) || isDisabled(element)) {
    return undefined;
  }

  if (isInputElement(element) && isTextEntryInput(element)) {
    return element;
  }

  if (isTextAreaElement(element) && !element.readOnly) {
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
  if (isInputElement(element) || isTextAreaElement(element)) {
    return element.value;
  }

  return element.textContent || "";
}

function normalizeTypedValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function skipAlreadyFilledField(editable: TextEditableElement): ContentActionResult {
  const nextElement = focusAdjacentElement(false, editable.ownerDocument);
  const advanceMessage = nextElement ? ` Focused next field ${describeElement(nextElement)}.` : "";

  return {
    ok: true,
    message: `Skipped typing because ${describeElement(editable)} already has a value.${advanceMessage}`
  };
}

function findNestedTextEditable(element: HTMLElement): TextEditableElement | undefined {
  const nestedElements = queryDescendants(element, textEditableSelector);
  for (const nested of nestedElements) {
    const editable = getTextEditableElement(nested);
    if (editable) {
      return editable;
    }
  }

  return undefined;
}

function findFileInputTarget(element: HTMLElement, visited = new Set<HTMLElement>()): HTMLInputElement | undefined {
  if (visited.has(element)) {
    return undefined;
  }
  visited.add(element);

  if (isInputElement(element) && element.type === "file") {
    return element;
  }

  const labelControl = isLabelElement(element) ? element.control : undefined;
  if (labelControl && isInputElement(labelControl) && labelControl.type === "file") {
    return labelControl;
  }

  const closestLabel = element.closest("label");
  const closestLabelControl = closestLabel && isLabelElement(closestLabel) ? closestLabel.control : undefined;
  if (closestLabelControl && isInputElement(closestLabelControl) && closestLabelControl.type === "file") {
    return closestLabelControl;
  }

  const nestedFileInput = queryDescendants(element, fileInputSelector).find(isInputElement);
  if (nestedFileInput) {
    return nestedFileInput;
  }

  for (const associatedElement of getAssociatedElements(element)) {
    const associatedFileInput = findFileInputTarget(associatedElement, visited);
    if (associatedFileInput) {
      return associatedFileInput;
    }
  }

  const nearbyFileInput = findNearbyFileInput(element);
  return nearbyFileInput;
}

function findNearbyFileInput(element: HTMLElement): HTMLInputElement | undefined {
  let bestMatch: { input: HTMLInputElement; score: number } | undefined;
  for (const input of getAvailableFileInputs(element.ownerDocument)) {
    const score = scoreNearbyEditable(element, input);
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { input, score };
    }
  }
  return bestMatch && bestMatch.score >= 25 ? bestMatch.input : undefined;
}

function findFirstAvailableFileInput(): ElementLookup {
  const inputs = getAvailableFileInputs();
  if (inputs.length === 1) {
    return { ok: true, value: inputs[0] };
  }

  return {
    ok: false,
    recoverable: true,
    message: inputs.length === 0 ? "No file input was found on the page." : "Multiple file inputs were found. Provide the target elementId."
  };
}

function getAvailableFileInputs(ownerDocument = document): HTMLInputElement[] {
  return queryRootDeep(ownerDocument, fileInputSelector)
    .filter(isInputElement)
    .filter((input) => !input.disabled);
}

function getAssociatedTextEditable(element: HTMLElement): TextEditableElement | undefined {
  const associatedElements = getAssociatedElements(element);
  for (const associatedElement of associatedElements) {
    const editable = getTextEditableElement(associatedElement) || findNestedTextEditable(associatedElement);
    if (editable) {
      return editable;
    }
  }

  return undefined;
}

function getAssociatedElements(element: HTMLElement): HTMLElement[] {
  const elements: HTMLElement[] = [];
  const labelControl = isLabelElement(element) ? element.control : undefined;
  if (isHtmlElement(labelControl)) {
    elements.push(labelControl);
  }

  const closestLabel = element.closest("label");
  if (closestLabel && isLabelElement(closestLabel) && isHtmlElement(closestLabel.control)) {
    elements.push(closestLabel.control);
  }

  const idReferences = [
    element.getAttribute("for"),
    element.getAttribute("aria-controls"),
    element.getAttribute("aria-owns"),
    element.getAttribute("aria-activedescendant")
  ]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(/\s+/));

  for (const id of idReferences) {
    const referencedElement = getElementByIdNear(element, id);
    if (referencedElement) {
      elements.push(referencedElement);
    }
  }

  return uniqueElements(elements);
}

function getEditableActivationTargets(
  originalElement: HTMLElement,
  editable?: TextEditableElement
): HTMLElement[] {
  const targets: HTMLElement[] = [];
  const labelControl = isLabelElement(originalElement) ? originalElement.control : undefined;
  if (isHtmlElement(labelControl)) {
    targets.push(originalElement);
  }

  const wrapper = editable ? findLikelyEditableWrapper(editable, originalElement) : undefined;
  if (wrapper) {
    targets.push(wrapper);
  }

  const nearestContext = originalElement.closest(editableContextSelector);
  if (isHtmlElement(nearestContext) && isLikelyEditableWrapper(nearestContext)) {
    targets.push(nearestContext);
  }

  targets.push(originalElement);

  if (editable && editable !== originalElement) {
    targets.push(editable);
  }

  return uniqueElements(targets).filter((target) => isVisibleElement(target) && !isDisabled(target));
}

function findLikelyEditableWrapper(editable: HTMLElement, boundary: HTMLElement): HTMLElement | undefined {
  let current = editable.parentElement;
  let depth = 0;

  const rootBoundary = getRootBoundaryElement(editable);
  while (current && current !== rootBoundary && depth < 5) {
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
    isLabelElement(element) ||
    role === "textbox" ||
    role === "combobox" ||
    element.tabIndex >= 0 ||
    element.hasAttribute("onclick") ||
    /InputBase|OutlinedInput|FilledInput|FormControl|Autocomplete|Select|TextField|field|input|control/i.test(className)
  );
}

async function waitForActiveTextEditable(
  originalElement: HTMLElement,
  activeBefore: HTMLElement | undefined,
  initialTarget: TextEditableElement | undefined,
  timeoutMs: number
): Promise<TextEditableElement | undefined> {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const activeEditable = getActiveTextEditable(originalElement.ownerDocument);
    if (activeEditable && isLikelyEditableForTarget(originalElement, activeEditable, activeBefore, initialTarget)) {
      return activeEditable;
    }

    await sleep(40);
  }

  return undefined;
}

function getActiveTextEditable(ownerDocument = document): TextEditableElement | undefined {
  const activeElement = getDeepActiveElement(ownerDocument);
  if (!activeElement) {
    return undefined;
  }

  return getTextEditableElement(activeElement) || findNestedTextEditable(activeElement);
}

function isLikelyEditableForTarget(
  originalElement: HTMLElement,
  editable: TextEditableElement,
  activeBefore: HTMLElement | undefined,
  initialTarget: TextEditableElement | undefined
): boolean {
  if (editable === initialTarget || originalElement === editable || originalElement.contains(editable)) {
    return true;
  }

  const activeChanged = !activeBefore || (editable !== activeBefore && !editable.contains(activeBefore));
  if (activeChanged) {
    return true;
  }

  return areElementsInSameEditableContext(originalElement, editable);
}

function findNearbyTextEditable(element: HTMLElement): TextEditableElement | undefined {
  let bestMatch: { editable: TextEditableElement; score: number } | undefined;

  for (const candidate of getVisibleTextEditableCandidates(element)) {
    const score = scoreNearbyEditable(element, candidate);
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { editable: candidate, score };
    }
  }

  return bestMatch && bestMatch.score >= 35 ? bestMatch.editable : undefined;
}

function getVisibleTextEditableCandidates(source?: HTMLElement): TextEditableElement[] {
  const root = getSearchRoot(source);
  const candidates = queryRootDeep(root, textEditableSelector)
    .map(getTextEditableElement)
    .filter((element): element is TextEditableElement => Boolean(element));

  return uniqueElements(candidates);
}

function scoreNearbyEditable(source: HTMLElement, candidate: TextEditableElement): number {
  let score = 0;

  if (source === candidate) {
    score += 500;
  }
  if (source.contains(candidate)) {
    score += 250;
  }
  if (candidate.contains(source)) {
    score += 160;
  }
  if (areElementsInSameEditableContext(source, candidate)) {
    score += 120;
  }
  if (!hasExistingEditableValue(candidate)) {
    score += 35;
  } else {
    score -= 25;
  }

  const sourceRect = source.getBoundingClientRect();
  const candidateRect = candidate.getBoundingClientRect();
  const distance = getRectDistance(sourceRect, candidateRect);
  score += Math.max(0, 140 - distance / 3);

  if (Math.abs(sourceRect.top - candidateRect.top) < 90) {
    score += 20;
  }
  if (candidateRect.top >= sourceRect.top - 40 && candidateRect.top <= sourceRect.bottom + 180) {
    score += 18;
  }

  return score;
}

function areElementsInSameEditableContext(a: HTMLElement, b: HTMLElement): boolean {
  const aContext = getEditableContext(a);
  const bContext = getEditableContext(b);
  return Boolean(aContext && bContext && aContext === bContext);
}

function getEditableContext(element: HTMLElement): HTMLElement | undefined {
  const context = element.closest(editableContextSelector);
  return isHtmlElement(context) ? context : undefined;
}

function getElementDistance(a: HTMLElement, b: HTMLElement): number {
  return getRectDistance(a.getBoundingClientRect(), b.getBoundingClientRect());
}

function getRectDistance(a: DOMRect, b: DOMRect): number {
  const aCenterX = a.left + a.width / 2;
  const aCenterY = a.top + a.height / 2;
  const bCenterX = b.left + b.width / 2;
  const bCenterY = b.top + b.height / 2;
  return Math.hypot(aCenterX - bCenterX, aCenterY - bCenterY);
}

function uniqueElements<T extends HTMLElement>(elements: T[]): T[] {
  const seen = new Set<T>();
  const unique: T[] = [];
  for (const element of elements) {
    if (seen.has(element)) {
      continue;
    }
    seen.add(element);
    unique.push(element);
  }
  return unique;
}

function activateForTyping(element: HTMLElement): void {
  prepareElement(element);
  dispatchPointerSequence(element);
  element.click();
}

function isTextEntryInput(element: HTMLInputElement): boolean {
  return !element.readOnly && !["button", "submit", "reset", "checkbox", "radio", "file", "hidden"].includes(element.type);
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

  const activeElement = getDeepActiveElement() || document.body;
  dispatchKeyboardEvent(activeElement, "keydown", normalizedKey);

  const target = focusAdjacentElement(normalizedKey === "Shift+Tab", activeElement.ownerDocument);
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

function focusAdjacentElement(reverse: boolean, ownerDocument = document): HTMLElement | undefined {
  const focusableElements = getKeyboardFocusableElements(ownerDocument);
  if (focusableElements.length === 0) {
    return undefined;
  }

  const activeElement = getDeepActiveElement(ownerDocument);
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

function getKeyboardFocusableElements(ownerDocument = document): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  const focusableElements: HTMLElement[] = [];

  for (const element of queryRootDeep(ownerDocument, keyboardFocusableSelector)) {
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

  if (isSelectElement(element) || isButtonElement(element) || isAnchorElement(element)) {
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

  if (!isSelectElement(element)) {
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

function getElementAtPoint(point: { clientX: number; clientY: number }, ownerDocument = document): HTMLElement | undefined {
  const element = ownerDocument.elementFromPoint(point.clientX, point.clientY);
  return isHtmlElement(element) ? element : undefined;
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
  const currentElement = element?.isConnected ? element : findMappedElementReplacement(elementId);
  if (!currentElement?.isConnected) {
    return {
      ok: false,
      recoverable: true,
      message: "The target element is no longer available. Refreshed the page context; choose a current visible element ID next."
    };
  }

  if (isDisabled(currentElement)) {
    return {
      ok: false,
      message: "The target element is disabled."
    };
  }

  return { ok: true, value: currentElement };
}

function isDisabled(element: HTMLElement): boolean {
  if (
    isButtonElement(element) ||
    isInputElement(element) ||
    isTextAreaElement(element) ||
    isSelectElement(element)
  ) {
    return element.disabled;
  }

  return element.getAttribute("aria-disabled") === "true";
}

function isVisibleElement(element: HTMLElement): boolean {
  const style = (element.ownerDocument.defaultView || window).getComputedStyle(element);
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

  if (isInputElement(target) && (target.type === "checkbox" || target.type === "radio")) {
    dispatchPointerSequence(target);
    target.click();
    setNativeChecked(target, true);
    dispatchFormEvents(target);
    return;
  }

  dispatchPointerSequence(target);
  target.click();
}

function isAlreadySelectedChoice(element: HTMLElement): boolean {
  if (isInputElement(element) && (element.type === "checkbox" || element.type === "radio")) {
    return element.checked;
  }

  const nestedChoice = queryDescendants(element, "input[type='checkbox'],input[type='radio']").find(isInputElement);
  if (nestedChoice) {
    return nestedChoice.checked;
  }

  return element.getAttribute("aria-checked") === "true" || element.getAttribute("aria-selected") === "true";
}

function getBestActivationTarget(element: HTMLElement): HTMLElement {
  if (isLabelElement(element) && isHtmlElement(element.control)) {
    return element.control;
  }

  if (findNestedTextEditable(element) && isLikelyEditableWrapper(element)) {
    return element;
  }

  const labelledControl = queryDescendants(element, "input,button,select,textarea,[role='radio'],[role='checkbox']")[0];
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
  const ownerWindow = element.ownerDocument.defaultView || window;
  const prototype =
    isTextAreaElement(element)
      ? ownerWindow.HTMLTextAreaElement.prototype
      : isSelectElement(element)
        ? ownerWindow.HTMLSelectElement.prototype
        : ownerWindow.HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  descriptor?.set?.call(element, value);
}

function setNativeChecked(element: HTMLInputElement, checked: boolean): void {
  const ownerWindow = element.ownerDocument.defaultView || window;
  const descriptor = Object.getOwnPropertyDescriptor(ownerWindow.HTMLInputElement.prototype, "checked");
  descriptor?.set?.call(element, checked);
}

function queryDescendants(element: HTMLElement, selector: string): HTMLElement[] {
  const results: HTMLElement[] = [];

  try {
    results.push(...Array.from(element.querySelectorAll(selector)).filter(isHtmlElement));
  } catch {
    return results;
  }

  collectShadowDescendants(element, selector, results, 0);
  return uniqueElements(results);
}

function queryRootDeep(root: QueryRoot, selector: string): HTMLElement[] {
  const elements = queryRoot(root, selector);
  for (const host of queryRoot(root, "*")) {
    collectShadowDescendants(host, selector, elements, 0);
  }
  return uniqueElements(elements);
}

function queryRoot(root: QueryRoot, selector: string): HTMLElement[] {
  try {
    return Array.from(root.querySelectorAll(selector)).filter(isHtmlElement);
  } catch {
    return [];
  }
}

function collectShadowDescendants(
  rootElement: HTMLElement,
  selector: string,
  results: HTMLElement[],
  depth: number
): void {
  if (depth >= 4) {
    return;
  }

  const shadowRoots: ShadowRoot[] = [];
  if (rootElement.shadowRoot) {
    shadowRoots.push(rootElement.shadowRoot);
  }

  for (const descendant of Array.from(rootElement.querySelectorAll("*")).filter(isHtmlElement)) {
    if (descendant.shadowRoot) {
      shadowRoots.push(descendant.shadowRoot);
    }
  }

  for (const shadowRoot of shadowRoots) {
    results.push(...queryRoot(shadowRoot, selector));
    for (const nestedHost of queryRoot(shadowRoot, "*")) {
      collectShadowDescendants(nestedHost, selector, results, depth + 1);
    }
  }
}

function getSearchRoot(source?: HTMLElement): QueryRoot {
  const root = source?.getRootNode();
  if (root && isShadowRoot(root)) {
    return root;
  }
  if (root && isDocumentRoot(root)) {
    return root;
  }
  return source?.ownerDocument || document;
}

function getElementByIdNear(element: HTMLElement, id: string): HTMLElement | undefined {
  const root = element.getRootNode();
  const found =
    isDocumentRoot(root) ? root.getElementById(id) : isShadowRoot(root) ? root.getElementById(id) : element.ownerDocument.getElementById(id);
  return isHtmlElement(found) ? found : undefined;
}

function getRootBoundaryElement(element: HTMLElement): HTMLElement | undefined {
  const root = element.getRootNode();
  if (isDocumentRoot(root)) {
    return root.body || root.documentElement;
  }
  if (isShadowRoot(root) && isHtmlElement(root.host)) {
    return root.host;
  }
  return undefined;
}

function getDeepActiveElement(ownerDocument = document): HTMLElement | undefined {
  const activeElement = ownerDocument.activeElement;
  if (!isHtmlElement(activeElement)) {
    return undefined;
  }

  const shadowActive = getDeepShadowActiveElement(activeElement);
  if (shadowActive) {
    return shadowActive;
  }

  if (isIframeElement(activeElement)) {
    try {
      return activeElement.contentDocument ? getDeepActiveElement(activeElement.contentDocument) || activeElement : activeElement;
    } catch {
      return activeElement;
    }
  }

  return activeElement;
}

function getDeepShadowActiveElement(element: HTMLElement): HTMLElement | undefined {
  const activeElement = element.shadowRoot?.activeElement;
  if (!isHtmlElement(activeElement)) {
    return undefined;
  }

  return getDeepShadowActiveElement(activeElement) || activeElement;
}

function isDocumentRoot(root: Node): root is Document {
  return root.nodeType === 9;
}

function isShadowRoot(root: Node): root is ShadowRoot {
  return root.nodeType === 11 && "host" in root;
}

function isIframeElement(element: HTMLElement): element is HTMLIFrameElement {
  return element.tagName.toLowerCase() === "iframe";
}

function isHtmlElement(element: Element | null | undefined): element is HTMLElement {
  if (!element) {
    return false;
  }

  const ctor = element.ownerDocument.defaultView?.HTMLElement;
  return typeof ctor === "function" ? element instanceof ctor : element.nodeType === 1;
}

function isElementInstance<T extends HTMLElement>(element: Element, constructorName: HtmlConstructorName): element is T {
  const ctor = element.ownerDocument.defaultView?.[constructorName];
  return typeof ctor === "function" && element instanceof ctor;
}

function isInputElement(element: Element): element is HTMLInputElement {
  return isElementInstance<HTMLInputElement>(element, "HTMLInputElement");
}

function isTextAreaElement(element: Element): element is HTMLTextAreaElement {
  return isElementInstance<HTMLTextAreaElement>(element, "HTMLTextAreaElement");
}

function isSelectElement(element: Element): element is HTMLSelectElement {
  return isElementInstance<HTMLSelectElement>(element, "HTMLSelectElement");
}

function isButtonElement(element: Element): element is HTMLButtonElement {
  return isElementInstance<HTMLButtonElement>(element, "HTMLButtonElement");
}

function isAnchorElement(element: Element): element is HTMLAnchorElement {
  return isElementInstance<HTMLAnchorElement>(element, "HTMLAnchorElement");
}

function isLabelElement(element: Element): element is HTMLLabelElement {
  return isElementInstance<HTMLLabelElement>(element, "HTMLLabelElement");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
