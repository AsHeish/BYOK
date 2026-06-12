import type { DomElementInfo, ExtractedPageData, PageObservation } from "../shared/types";

const MAX_DOM_ELEMENTS = 80;
const MAX_PAGE_TEXT_CHARS = 10000;
const MAX_ELEMENT_CONTEXT_CHARS = 900;
const READABLE_TEXT_SELECTOR = [
  "main",
  "article",
  "section",
  "form",
  "[role='main']",
  "[class*='question']",
  "[class*='Question']",
  "[class*='problem']",
  "[class*='Problem']",
  "h1",
  "h2",
  "h3",
  "p",
  "li",
  "label",
  "button",
  "summary",
  "td",
  "th",
  "div"
].join(",");

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
const currentElementInfo = new Map<string, DomElementInfo>();
const historicalElementInfo = new Map<string, DomElementInfo>();
let nextElementId = 1;

export function observePage(): PageObservation {
  currentElements.clear();
  currentElementInfo.clear();

  const elements = getCandidateInteractiveElements()
    .filter(isVisibleElement)
    .sort(compareElementsForCurrentViewport)
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

export function findMappedElementReplacement(elementId: string): HTMLElement | undefined {
  const snapshot = currentElementInfo.get(elementId) || historicalElementInfo.get(elementId);
  if (!snapshot) {
    return undefined;
  }

  observePage();

  const refreshedElement = currentElements.get(elementId);
  if (refreshedElement && document.documentElement.contains(refreshedElement)) {
    return refreshedElement;
  }

  let bestMatch: { element: HTMLElement; score: number; tiedMatches: number } | undefined;
  for (const candidate of getCandidateInteractiveElements().filter(isVisibleElement)) {
    if (isDisabled(candidate)) {
      continue;
    }

    const score = scoreElementMatch(snapshot, toElementInfo(candidate));
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { element: candidate, score, tiedMatches: 1 };
    } else if (score === bestMatch.score) {
      bestMatch.tiedMatches += 1;
    }
  }

  const minimumScore = snapshot.context || snapshot.questionNumber ? 12 : 8;
  return bestMatch && bestMatch.score >= minimumScore && bestMatch.tiedMatches === 1 ? bestMatch.element : undefined;
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

  const info: DomElementInfo = {
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
    checkedState: getCheckedState(element),
    href: element instanceof HTMLAnchorElement ? element.href : undefined,
    options: nestedSelect ? Array.from(nestedSelect.options).map((option) => option.text || option.value).slice(0, 30) : undefined,
    isDraggable: isDraggable || undefined,
    isDropTarget: isDropTarget || undefined,
    isFocused: isElementFocused(element),
    isDisabled: isDisabled(element),
    isSensitive: false
  };

  rememberElementInfo(info);
  return info;
}

function rememberElementInfo(info: DomElementInfo): void {
  currentElementInfo.set(info.id, info);
  historicalElementInfo.set(info.id, info);

  while (historicalElementInfo.size > 300) {
    const oldestId = historicalElementInfo.keys().next().value;
    if (!oldestId) {
      break;
    }
    historicalElementInfo.delete(oldestId);
  }
}

function scoreElementMatch(snapshot: DomElementInfo, candidate: DomElementInfo): number {
  let score = 0;

  if (snapshot.tag === candidate.tag) {
    score += 2;
  }
  if (snapshot.role && snapshot.role === candidate.role) {
    score += 2;
  }
  if (snapshot.type && snapshot.type === candidate.type) {
    score += 2;
  }
  if (snapshot.name && snapshot.name === candidate.name) {
    score += 5;
  }
  if (snapshot.placeholder && snapshot.placeholder === candidate.placeholder) {
    score += 4;
  }
  if (snapshot.questionNumber && snapshot.questionNumber === candidate.questionNumber) {
    score += 8;
  }

  score += scoreTextField(snapshot.label, candidate.label, 8, 4);
  score += scoreTextField(snapshot.text, candidate.text, 7, 3);
  score += scoreTextField(snapshot.context, candidate.context, 10, 5);

  if (snapshot.checkedState && candidate.checkedState) {
    score += 1;
  }
  if (snapshot.isDraggable && candidate.isDraggable) {
    score += 3;
  }
  if (snapshot.isDropTarget && candidate.isDropTarget) {
    score += 3;
  }

  return score;
}

function scoreTextField(
  snapshotValue: string | undefined,
  candidateValue: string | undefined,
  exactScore: number,
  partialScore: number
): number {
  const snapshotText = normalizeText(snapshotValue || "").toLowerCase();
  const candidateText = normalizeText(candidateValue || "").toLowerCase();
  if (!snapshotText || !candidateText) {
    return 0;
  }

  if (snapshotText === candidateText) {
    return exactScore;
  }

  return snapshotText.includes(candidateText) || candidateText.includes(snapshotText) ? partialScore : 0;
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
  const viewportText = getScrollAwareReadableText();
  if (viewportText) {
    return viewportText;
  }

  const text = normalizeText(document.body?.innerText || document.documentElement.textContent || "");
  return text.slice(0, MAX_PAGE_TEXT_CHARS);
}

function getScrollAwareReadableText(): string {
  const textBlocks = Array.from(document.querySelectorAll<HTMLElement>(READABLE_TEXT_SELECTOR))
    .filter(isVisibleElement)
    .map((element) => ({ element, rect: element.getBoundingClientRect(), text: getDirectReadableBlockText(element) }))
    .filter((block) => block.text.length > 0)
    .sort((a, b) => scoreBlockForCurrentViewport(a.rect) - scoreBlockForCurrentViewport(b.rect));

  const selectedBlocks: Array<{ top: number; text: string }> = [];
  let usedChars = 0;
  const seen = new Set<string>();

  for (const block of textBlocks) {
    const text = block.text.slice(0, 900);
    if (seen.has(text)) {
      continue;
    }

    const nextCost = text.length + 1;
    if (usedChars + nextCost > MAX_PAGE_TEXT_CHARS) {
      continue;
    }

    selectedBlocks.push({ top: block.rect.top + window.scrollY, text });
    seen.add(text);
    usedChars += nextCost;
  }

  return normalizeText(
    selectedBlocks
      .sort((a, b) => a.top - b.top)
      .map((block) => block.text)
      .join("\n")
  ).slice(0, MAX_PAGE_TEXT_CHARS);
}

function getDirectReadableBlockText(element: HTMLElement): string {
  const tag = element.tagName.toLowerCase();
  const text = normalizeText(element.innerText || element.textContent || "");
  if (!text) {
    return "";
  }

  const className = String(element.getAttribute("class") || "");
  const isQuestionLike = /question|problem|prompt|answer|quiz|module|task/i.test(className);

  if (["main", "article", "section", "form"].includes(tag) || element.getAttribute("role") === "main") {
    return text.length <= 1400 ? text : "";
  }

  if (tag === "div" && text.length > 700 && !isQuestionLike) {
    return "";
  }

  return text;
}

function scoreBlockForCurrentViewport(rect: DOMRect): number {
  const viewportHeight = Math.max(window.innerHeight, 1);
  const viewportTop = 0;
  const viewportBottom = viewportHeight;

  if (rect.bottom >= viewportTop && rect.top <= viewportBottom) {
    return Math.abs(rect.top) * 0.1;
  }

  if (rect.top > viewportBottom) {
    return viewportHeight + rect.top - viewportBottom;
  }

  return viewportHeight * 4 + Math.abs(rect.bottom);
}

function compareElementsForCurrentViewport(a: HTMLElement, b: HTMLElement): number {
  return scoreElementForCurrentViewport(a) - scoreElementForCurrentViewport(b);
}

function scoreElementForCurrentViewport(element: HTMLElement): number {
  const rect = element.getBoundingClientRect();
  const viewportHeight = Math.max(window.innerHeight, 1);

  if (rect.bottom >= 0 && rect.top <= viewportHeight) {
    return Math.max(0, rect.top);
  }

  if (rect.top > viewportHeight) {
    return viewportHeight + rect.top - viewportHeight;
  }

  return viewportHeight * 4 + Math.abs(rect.bottom);
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

function getCheckedState(element: HTMLElement): "checked" | "unchecked" | "mixed" | undefined {
  if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) {
    return element.checked ? "checked" : "unchecked";
  }

  const nestedChoice = element.querySelector<HTMLInputElement>("input[type='checkbox'],input[type='radio']");
  if (nestedChoice) {
    return nestedChoice.checked ? "checked" : "unchecked";
  }

  const ariaChecked = element.getAttribute("aria-checked");
  if (ariaChecked === "true" || ariaChecked === "false" || ariaChecked === "mixed") {
    return ariaChecked === "true" ? "checked" : ariaChecked === "mixed" ? "mixed" : "unchecked";
  }

  const ariaSelected = element.getAttribute("aria-selected");
  if (ariaSelected === "true" || ariaSelected === "false") {
    return ariaSelected === "true" ? "checked" : "unchecked";
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
