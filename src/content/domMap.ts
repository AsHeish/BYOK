import type { DomElementInfo, ExtractedPageData, PageObservation } from "../shared/types";

const MAX_DOM_ELEMENTS = 80;
const MAX_PAGE_TEXT_CHARS = 12000;
const MAX_ELEMENT_CONTEXT_CHARS = 900;

const textEditableSelector = [
  "input:not([type='hidden']):not([type='button']):not([type='submit']):not([type='reset']):not([type='checkbox']):not([type='radio']):not([type='file'])",
  "textarea",
  "[contenteditable='true']"
].join(",");

const dragDropSelector = [
  "[draggable='true']",
  "[aria-grabbed]",
  "[aria-dropeffect]",
  "[data-rbd-draggable-id]",
  "[data-rbd-droppable-id]",
  "[data-draggable]",
  "[data-droppable]",
  "[data-drag-handle]",
  "[data-dnd-kit-draggable]",
  "[data-dnd-kit-droppable]",
  "[role='listbox']",
  "[role='listitem']",
  "[class*='drag']",
  "[class*='Drag']",
  "[class*='drop']",
  "[class*='Drop']",
  "[class*='sortable']",
  "[class*='Sortable']"
].join(",");

const interactiveSelector = [
  "a[href]",
  "button",
  "input:not([type='hidden'])",
  "label",
  "textarea",
  "select",
  "summary",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='menuitem']",
  "[role='option']",
  "[role='radio']",
  "[role='switch']",
  "[aria-checked]",
  "[contenteditable='true']",
  "[onclick]",
  "[tabindex]:not([tabindex='-1'])",
  ".MuiInputBase-root",
  ".MuiOutlinedInput-root",
  ".MuiFilledInput-root",
  ".MuiFormControl-root",
  ".MuiAutocomplete-root",
  ".MuiSelect-root",
  dragDropSelector
].join(",");

const weakIds = new WeakMap<Element, string>();
const currentElements = new Map<string, HTMLElement>();
let nextElementId = 1;

export function observePage(): PageObservation {
  currentElements.clear();

  const elements = getCandidateInteractiveElements()
    .filter(isVisibleElement)
    .slice(0, MAX_DOM_ELEMENTS)
    .map(toElementInfo);

  return {
    url: location.href,
    title: document.title,
    text: getReadableText(),
    elements
  };
}

function getCandidateInteractiveElements(): HTMLElement[] {
  const candidates = new Set<HTMLElement>();

  for (const element of Array.from(document.querySelectorAll<HTMLElement>(interactiveSelector))) {
    candidates.add(element);
  }

  for (const editable of Array.from(document.querySelectorAll<HTMLElement>(textEditableSelector))) {
    if (!isVisibleElement(editable)) {
      continue;
    }

    candidates.add(editable);

    const wrapper = findLikelyEditableWrapper(editable);
    if (wrapper) {
      candidates.add(wrapper);
    }
  }

  for (const dragOrDropElement of Array.from(document.querySelectorAll<HTMLElement>(dragDropSelector))) {
    if (isVisibleElement(dragOrDropElement)) {
      candidates.add(dragOrDropElement);
    }
  }

  return Array.from(candidates);
}

export function getMappedElement(elementId: string): HTMLElement | undefined {
  return currentElements.get(elementId);
}

export function extractPageData(): ExtractedPageData {
  return {
    url: location.href,
    title: document.title,
    headings: Array.from(document.querySelectorAll("h1,h2,h3"))
      .map((heading) => normalizeText(heading.textContent || ""))
      .filter(Boolean)
      .slice(0, 40),
    links: Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
      .filter(isVisibleElement)
      .map((link) => ({
        text: normalizeText(link.innerText || link.textContent || link.href),
        href: link.href
      }))
      .filter((link) => link.text || link.href)
      .slice(0, 80),
    tables: extractTables(),
    forms: extractForms(),
    text: getReadableText()
  };
}

function toElementInfo(element: HTMLElement): DomElementInfo {
  const id = getOrCreateElementId(element);
  currentElements.set(id, element);

  const tag = element.tagName.toLowerCase();
  const input = element instanceof HTMLInputElement ? element : undefined;
  const select = element instanceof HTMLSelectElement ? element : undefined;
  const nestedInput = input || getPrimaryTextEditableDescendant(element);
  const nestedSelect = select || getPrimarySelectDescendant(element);
  const questionContext = getElementQuestionContext(element);
  const isDraggable = isDraggableElement(element);
  const isDropTarget = isDropTargetElement(element);

  return {
    id,
    tag,
    role: element.getAttribute("role") || implicitRole(element),
    type: input?.type,
    text: getElementText(element),
    label: getElementLabel(element),
    name: getFormName(element),
    placeholder: getPlaceholder(element),
    context: questionContext?.text,
    questionNumber: questionContext?.questionNumber,
    value: getSafeValue(element),
    href: element instanceof HTMLAnchorElement ? element.href : undefined,
    options: nestedSelect ? Array.from(nestedSelect.options).map((option) => option.text || option.value).slice(0, 30) : undefined,
    isDraggable: isDraggable || undefined,
    isDropTarget: isDropTarget || undefined,
    isFocused: isElementFocused(element),
    isDisabled: isDisabled(element),
    isSensitive: false
  };
}

function getOrCreateElementId(element: Element): string {
  const existing = weakIds.get(element);
  if (existing) {
    return existing;
  }

  const id = `el-${nextElementId}`;
  nextElementId += 1;
  weakIds.set(element, id);
  return id;
}

function getReadableText(): string {
  const text = normalizeText(document.body?.innerText || document.documentElement.textContent || "");
  return text.slice(0, MAX_PAGE_TEXT_CHARS);
}

function getElementText(element: HTMLElement): string | undefined {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return undefined;
  }

  const text = normalizeText(element.innerText || element.textContent || "");
  return text ? text.slice(0, 160) : undefined;
}

function getElementLabel(element: HTMLElement): string | undefined {
  const ariaLabel = normalizeText(element.getAttribute("aria-label") || "");
  if (ariaLabel) {
    return ariaLabel.slice(0, 160);
  }

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const label = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || "")
      .map(normalizeText)
      .filter(Boolean)
      .join(" ");
    if (label) {
      return label.slice(0, 160);
    }
  }

  const controlLabels = getControlLabels(element);
  if (controlLabels) {
    return controlLabels.slice(0, 160);
  }

  const wrappingLabel = element.closest("label");
  if (wrappingLabel) {
    const label = normalizeText(wrappingLabel.textContent || "");
    if (label) {
      return label.slice(0, 160);
    }
  }

  const title = normalizeText(element.getAttribute("title") || "");
  return title ? title.slice(0, 160) : undefined;
}

function getControlLabels(element: HTMLElement): string | undefined {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    const labels = Array.from(element.labels || [])
      .map((label) => normalizeText(label.textContent || ""))
      .filter(Boolean);
    return labels.join(" ");
  }

  const nestedEditable = getPrimaryTextEditableDescendant(element);
  if (nestedEditable) {
    return getControlLabels(nestedEditable);
  }

  return undefined;
}

function getFormName(element: HTMLElement): string | undefined {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLButtonElement
  ) {
    return element.name || undefined;
  }

  const nestedEditable = getPrimaryTextEditableDescendant(element);
  if (
    nestedEditable instanceof HTMLInputElement ||
    nestedEditable instanceof HTMLTextAreaElement ||
    nestedEditable instanceof HTMLSelectElement
  ) {
    return nestedEditable.name || undefined;
  }

  return undefined;
}

function getPlaceholder(element: HTMLElement): string | undefined {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.placeholder || undefined;
  }

  const nestedEditable = getPrimaryTextEditableDescendant(element);
  if (nestedEditable instanceof HTMLInputElement || nestedEditable instanceof HTMLTextAreaElement) {
    return nestedEditable.placeholder || undefined;
  }

  return undefined;
}

function getSafeValue(element: HTMLElement): string | undefined {

  if (element instanceof HTMLSelectElement) {
    return element.selectedOptions[0]?.text || element.value || undefined;
  }

  if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) {
    const state = element.checked ? "checked" : "unchecked";
    return element.value ? `${element.value} (${state})` : state;
  }

  if (element instanceof HTMLInputElement && element.value && !["password", "file"].includes(element.type)) {
    return element.value.slice(0, 160);
  }

  const nestedEditable = getPrimaryTextEditableDescendant(element);
  if (nestedEditable && nestedEditable !== element) {
    return getSafeValue(nestedEditable);
  }

  return undefined;
}

function getElementQuestionContext(element: HTMLElement): { text: string; questionNumber?: string } | undefined {
  if (!shouldIncludeElementContext(element)) {
    return undefined;
  }

  const boundary = findQuestionContextBoundary(element) || document.body;
  const beforeText = getTextBeforeElement(boundary, element);
  const questionText = extractNearestQuestionText(beforeText);

  if (!questionText) {
    return undefined;
  }

  const fieldLabel = getElementLabel(element) || getPlaceholder(element) || getFormName(element) || "field";
  const text = normalizeText(`${questionText} Field: ${fieldLabel}`).slice(0, MAX_ELEMENT_CONTEXT_CHARS);
  const questionNumber = questionText.match(/Problem Statement\s+(\d+)/i)?.[1];

  return {
    text,
    questionNumber
  };
}

function shouldIncludeElementContext(element: HTMLElement): boolean {
  const role = element.getAttribute("role") || implicitRole(element) || "";

  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLLabelElement ||
    isDraggableElement(element) ||
    isDropTargetElement(element) ||
    role === "textbox" ||
    role === "combobox" ||
    Boolean(getPrimaryTextEditableDescendant(element)) ||
    Boolean(getPrimarySelectDescendant(element))
  );
}

function isDraggableElement(element: HTMLElement): boolean {
  return (
    element.draggable ||
    element.getAttribute("draggable") === "true" ||
    element.hasAttribute("aria-grabbed") ||
    element.hasAttribute("data-rbd-draggable-id") ||
    element.hasAttribute("data-draggable") ||
    element.hasAttribute("data-drag-handle") ||
    element.hasAttribute("data-dnd-kit-draggable")
  );
}

function isDropTargetElement(element: HTMLElement): boolean {
  const className = String(element.getAttribute("class") || "");
  const role = element.getAttribute("role") || "";

  return (
    element.hasAttribute("aria-dropeffect") ||
    element.hasAttribute("data-rbd-droppable-id") ||
    element.hasAttribute("data-droppable") ||
    element.hasAttribute("data-dnd-kit-droppable") ||
    role === "listbox" ||
    /drop|droppable|sortable|destination|target|answer/i.test(className)
  );
}

function findQuestionContextBoundary(element: HTMLElement): HTMLElement | undefined {
  let current = element.parentElement;
  let depth = 0;

  while (current && current !== document.body && depth < 10) {
    const text = normalizeText(current.innerText || current.textContent || "");
    if (/Problem Statement\s+\d+/i.test(text)) {
      return current;
    }

    current = current.parentElement;
    depth += 1;
  }

  return undefined;
}

function getTextBeforeElement(boundary: HTMLElement, element: HTMLElement): string {
  try {
    const range = document.createRange();
    range.selectNodeContents(boundary);
    range.setEndBefore(element);
    const text = normalizeText(range.toString());
    range.detach();
    return text;
  } catch {
    return normalizeText(boundary.innerText || boundary.textContent || "");
  }
}

function extractNearestQuestionText(beforeText: string): string | undefined {
  const matches = Array.from(beforeText.matchAll(/Problem Statement\s+\d+/gi));
  const lastMatch = matches.at(-1);
  if (!lastMatch || typeof lastMatch.index !== "number") {
    return undefined;
  }

  return beforeText.slice(lastMatch.index).trim();
}

function implicitRole(element: HTMLElement): string | undefined {
  if (element instanceof HTMLButtonElement) {
    return "button";
  }
  if (element instanceof HTMLAnchorElement) {
    return "link";
  }
  if (element instanceof HTMLLabelElement) {
    return "label";
  }
  if (element instanceof HTMLSelectElement) {
    return "combobox";
  }
  if (element instanceof HTMLTextAreaElement) {
    return "textbox";
  }
  if (element instanceof HTMLInputElement) {
    if (element.type === "checkbox") {
      return "checkbox";
    }
    if (element.type === "radio") {
      return "radio";
    }
    return "textbox";
  }
  if (getPrimaryTextEditableDescendant(element)) {
    return "textbox";
  }
  if (getPrimarySelectDescendant(element)) {
    return "combobox";
  }
  return undefined;
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

  const nestedEditable = getPrimaryTextEditableDescendant(element);
  if (
    nestedEditable instanceof HTMLInputElement ||
    nestedEditable instanceof HTMLTextAreaElement ||
    nestedEditable instanceof HTMLSelectElement
  ) {
    return nestedEditable.disabled;
  }

  return element.getAttribute("aria-disabled") === "true";
}

export function isSensitiveElement(_element: HTMLElement): boolean {
  return false;
}

function getPrimaryTextEditableDescendant(element: HTMLElement): HTMLElement | undefined {
  const editable = element.querySelector<HTMLElement>(textEditableSelector);
  return editable && isVisibleElement(editable) ? editable : undefined;
}

function getPrimarySelectDescendant(element: HTMLElement): HTMLSelectElement | undefined {
  const select = element.querySelector<HTMLSelectElement>("select");
  return select && isVisibleElement(select) ? select : undefined;
}

function findLikelyEditableWrapper(editable: HTMLElement): HTMLElement | undefined {
  let current = editable.parentElement;
  let depth = 0;

  while (current && current !== document.body && depth < 5) {
    if (isVisibleElement(current) && isLikelyEditableWrapper(current)) {
      return current;
    }
    current = current.parentElement;
    depth += 1;
  }

  return undefined;
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

function isElementFocused(element: HTMLElement): boolean {
  const activeElement = document.activeElement;
  return activeElement === element || Boolean(activeElement && element.contains(activeElement));
}

function isVisibleElement(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function extractTables(): ExtractedPageData["tables"] {
  return Array.from(document.querySelectorAll("table"))
    .filter(isVisibleElement)
    .slice(0, 10)
    .map((table) => {
      const caption = normalizeText(table.querySelector("caption")?.textContent || "");
      const headerCells = Array.from(table.querySelectorAll("thead th, tr:first-child th"))
        .map((cell) => normalizeText(cell.textContent || ""))
        .filter(Boolean);
      const rows = Array.from(table.querySelectorAll("tbody tr, tr"))
        .slice(0, 30)
        .map((row) =>
          Array.from(row.querySelectorAll("th,td"))
            .map((cell) => normalizeText(cell.textContent || ""))
            .filter(Boolean)
        )
        .filter((row) => row.length > 0);

      return {
        caption: caption || undefined,
        headers: headerCells.slice(0, 20),
        rows
      };
    });
}

function extractForms(): ExtractedPageData["forms"] {
  return Array.from(document.querySelectorAll("form"))
    .filter(isVisibleElement)
    .slice(0, 10)
    .map((form) => {
      const controls = Array.from(form.querySelectorAll<HTMLElement>(interactiveSelector))
        .filter(isVisibleElement)
        .slice(0, 40)
        .map(toElementInfo);
      const labels = controls.map((control) => control.label || control.text || control.placeholder || "").filter(Boolean);
      return { labels, controls };
    });
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
