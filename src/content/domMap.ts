import type { DomElementInfo, ExtractedPageData, PageObservation } from "../shared/types";

const MAX_DOM_ELEMENTS = 80;
const MAX_PAGE_TEXT_CHARS = 12000;

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
  "[tabindex]:not([tabindex='-1'])"
].join(",");

const weakIds = new WeakMap<Element, string>();
const currentElements = new Map<string, HTMLElement>();
let nextElementId = 1;

export function observePage(): PageObservation {
  currentElements.clear();

  const elements = Array.from(document.querySelectorAll<HTMLElement>(interactiveSelector))
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

  return {
    id,
    tag,
    role: element.getAttribute("role") || implicitRole(element),
    type: input?.type,
    text: getElementText(element),
    label: getElementLabel(element),
    name: getFormName(element),
    placeholder: getPlaceholder(element),
    value: getSafeValue(element),
    href: element instanceof HTMLAnchorElement ? element.href : undefined,
    options: select ? Array.from(select.options).map((option) => option.text || option.value).slice(0, 30) : undefined,
    isDisabled: isDisabled(element),
    isSensitive: isSensitiveElement(element)
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

  return undefined;
}

function getPlaceholder(element: HTMLElement): string | undefined {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.placeholder || undefined;
  }

  return undefined;
}

function getSafeValue(element: HTMLElement): string | undefined {
  if (isSensitiveElement(element)) {
    return undefined;
  }

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

  return undefined;
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

  return element.getAttribute("aria-disabled") === "true";
}

export function isSensitiveElement(element: HTMLElement): boolean {
  const sensitiveFieldPattern = /password|passcode|otp|2fa|mfa|token|secret|credential|api[-_ ]?key|session|csrf|credit|card|cvv|cvc|ssn|social security/i;

  if (element instanceof HTMLInputElement) {
    if (["password", "file"].includes(element.type)) {
      return true;
    }
  }

  const joined = [
    element.getAttribute("autocomplete"),
    element.getAttribute("name"),
    element.getAttribute("id"),
    element.getAttribute("aria-label"),
    element.getAttribute("placeholder"),
    element.getAttribute("data-testid")
  ]
    .filter(Boolean)
    .join(" ");

  return sensitiveFieldPattern.test(joined);
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
