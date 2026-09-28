import type {
  ContentWaitCheckRequest,
  ContentWaitCheckResult,
  DomElementInfo,
  ExtractedPageData,
  PageFrameInfo,
  PageObservation,
} from "../shared/types";

const MAX_DOM_ELEMENTS = 80;
const MAX_PAGE_TEXT_CHARS = 10000;
const MAX_ELEMENT_CONTEXT_CHARS = 900;
const MAX_DOM_ROOTS = 30;
const MAX_FRAME_DEPTH = 2;
const MAX_SHADOW_DEPTH = 4;
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
const frameIds = new WeakMap<Element, string>();
const elementContexts = new WeakMap<Element, Pick<DomElementInfo, "frameContext" | "rootContext">>();
const currentElements = new Map<string, HTMLElement>();
const currentElementInfo = new Map<string, DomElementInfo>();
const historicalElementInfo = new Map<string, DomElementInfo>();
const documentId = crypto.randomUUID();
let nextElementId = 1;
let nextFrameId = 1;
let lastScrollDirection: "up" | "down" | "left" | "right" = "down";

type QueryRoot = Document | ShadowRoot;

interface DomRootContext {
  root: QueryRoot;
  frameContext?: string;
  rootContext: string;
  frameDepth: number;
  shadowDepth: number;
}

interface DomContextCollection {
  roots: DomRootContext[];
  frames: PageFrameInfo[];
}

type HtmlConstructorName =
  | "HTMLElement"
  | "HTMLInputElement"
  | "HTMLTextAreaElement"
  | "HTMLSelectElement"
  | "HTMLButtonElement"
  | "HTMLAnchorElement"
  | "HTMLLabelElement";

export function observePage(): PageObservation {
  currentElements.clear();
  currentElementInfo.clear();

  const contexts = collectDomContexts();
  const interactiveElements = getCandidateInteractiveElements(contexts)
    .filter(isVisibleElement)
    .sort(compareElementsForCurrentViewport);
  const elements = interactiveElements
    .slice(0, MAX_DOM_ELEMENTS)
    .map(toElementInfo);
  const privateValues = queryAllInContexts(contexts, "input,textarea,[contenteditable='true']")
    .filter(isSensitiveElement)
    .map((element) => "value" in element ? String(element.value || "") : element.textContent || "")
    .filter((value) => value.length > 0);
  const redact = (text: string) => privateValues.reduce((value, secret) => value.split(secret).join("[redacted]"), text);

  return {
    documentId,
    formState: getFormStateFingerprint(),
    isLoading: document.readyState !== "complete" || queryAllInContexts(contexts, '[aria-busy="true"],[role="progressbar"]').some(isVisibleElement),
    url: location.href,
    title: redact(document.title),
    text: redact(getReadableText(contexts)),
    elements: elements.map((element) => Object.fromEntries(Object.entries(element).map(([key, value]) => [key,
      key === "id" || key === "fingerprint" ? value : typeof value === "string" ? redact(value) : Array.isArray(value) ? value.map(redact) : value,
    ])) as unknown as DomElementInfo),
    interactiveElementCount: interactiveElements.length,
    viewport: getViewportInfo(contexts),
    frames: contexts.frames
  };
}

export function checkWaitCondition(request: ContentWaitCheckRequest): ContentWaitCheckResult {
  const bodyText = request.condition === "text_present" || request.condition === "text_absent"
    ? normalizeText(document.body?.innerText || document.body?.textContent || "").toLowerCase()
    : "";
  const expectedText = normalizeText(request.text || "").toLowerCase();
  const element = request.elementId ? getMappedElement(request.elementId) : undefined;
  const matched = (() => {
    switch (request.condition) {
      case "document_ready":
        return document.readyState === "complete";
      case "url_changed":
        return Boolean(request.baselineUrl && location.href !== request.baselineUrl);
      case "text_present":
        return Boolean(expectedText && bodyText.includes(expectedText));
      case "text_absent":
        return Boolean(expectedText && !bodyText.includes(expectedText));
      case "element_hidden":
        return !element || !isVisibleElement(element);
      case "element_enabled":
        return Boolean(element && isVisibleElement(element) && !isDisabled(element));
      case "dom_stable":
        return false;
    }
  })();

  return {
    matched,
    signature: buildDomStabilitySignature(),
    url: location.href,
    readyState: document.readyState,
  };
}

function buildDomStabilitySignature(): string {
  const contexts = collectDomContexts();
  const text = contexts.roots
    .map((context) => normalizeText(
      isDocumentRoot(context.root)
        ? context.root.body?.innerText || context.root.body?.textContent || ""
        : context.root.textContent || "",
    ))
    .join("|")
    .slice(0, 8_000);
  const controls = queryAllInContexts(contexts, "input,textarea,select,button").slice(0, 200);
  const controlState = controls
    .slice(0, 200)
    .map((element) => {
      if (isInputElement(element)) {
        return `${element.type}:${element.value}:${element.checked}:${element.disabled}`;
      }
      if (isTextAreaElement(element)) {
        return `textarea:${element.value}:${element.disabled}`;
      }
      if (isSelectElement(element)) {
        return `select:${element.value}:${element.selectedIndex}:${element.disabled}`;
      }
      return isButtonElement(element)
        ? `button:${element.disabled}:${normalizeText(element.textContent || "")}`
        : element.tagName.toLowerCase();
    })
    .join("|");
  return [
    location.href,
    document.readyState,
    contexts.roots.length,
    contexts.roots.reduce((count, context) => count + queryRoot(context.root, "*").length, 0),
    text.length,
    hashText(text),
    queryAllInContexts(contexts, "input,textarea,select,button,a[href],[role='button'],[role='textbox']").length,
    hashText(controlState),
    hashText(JSON.stringify(contexts.frames)),
  ].join(":");
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function getViewportInfo(contexts: DomContextCollection): PageObservation["viewport"] {
  const container = findScrollContainer(lastScrollDirection, contexts);
  const owner = container.ownerDocument;
  const view = owner.defaultView || window;
  const root = container === (owner.scrollingElement || owner.documentElement);
  const viewportWidth = root ? view.innerWidth || container.clientWidth : container.clientWidth;
  const viewportHeight = root ? view.innerHeight || container.clientHeight : container.clientHeight;
  const pageWidth = Math.max(container.scrollWidth, root ? owner.body?.scrollWidth || 0 : 0, viewportWidth);
  const pageHeight = Math.max(container.scrollHeight, root ? owner.body?.scrollHeight || 0 : 0, viewportHeight);
  const scrollX = Math.max(0, Math.round(container.scrollLeft || (root ? view.scrollX : 0) || 0));
  const scrollY = Math.max(0, Math.round(container.scrollTop || (root ? view.scrollY : 0) || 0));
  const maxScrollableY = Math.max(0, pageHeight - viewportHeight);
  return {
    scrollContainerId: getOrCreateElementId(container),
    scrollContainerLabel: root ? "document" : container.getAttribute("aria-label") || container.id || container.getAttribute("role") || container.tagName.toLowerCase(),
    scrollX,
    scrollY,
    viewportWidth: Math.round(viewportWidth),
    viewportHeight: Math.round(viewportHeight),
    pageWidth: Math.round(pageWidth),
    pageHeight: Math.round(pageHeight),
    progressPercent: maxScrollableY ? Math.min(100, Math.max(0, Math.round(scrollY / maxScrollableY * 100))) : 100,
  };
}

export function getScrollContainer(direction: "up" | "down" | "left" | "right"): HTMLElement {
  lastScrollDirection = direction;
  return findScrollContainer(direction, collectDomContexts());
}

function findScrollContainer(direction: "up" | "down" | "left" | "right", contexts: DomContextCollection): HTMLElement {
  const horizontal = direction === "left" || direction === "right";
  const candidates = queryAllInContexts(contexts, "*");
  let best: { element: HTMLElement; score: number } | undefined;
  for (const element of candidates) {
    const owner = element.ownerDocument;
    const view = owner.defaultView || window;
    const root = element === (owner.scrollingElement || owner.documentElement);
    const size = root ? horizontal ? view.innerWidth : view.innerHeight : horizontal ? element.clientWidth : element.clientHeight;
    const extent = horizontal ? Math.max(element.scrollWidth, root ? owner.body?.scrollWidth || 0 : 0)
      : Math.max(element.scrollHeight, root ? owner.body?.scrollHeight || 0 : 0);
    if (size <= 0 || extent <= size + 1) continue;
    const style = view.getComputedStyle(element);
    const overflow = horizontal ? style.overflowX || style.overflow : style.overflowY || style.overflow;
    if (!root && !/^(auto|scroll|overlay)$/.test(overflow)) continue;
    if (root && /^(hidden|clip)$/.test(overflow)) continue;
    const area = visibleScrollArea(element);
    if (!area) continue;
    const focused = !root && owner.activeElement && owner.activeElement !== owner.body && element.contains(owner.activeElement);
    const dialog = element.closest('dialog[open],[role="dialog"],[aria-modal="true"]');
    const score = area + (focused ? view.innerWidth * view.innerHeight : 0) + (dialog ? view.innerWidth * view.innerHeight * 2 : 0);
    if (!best || score > best.score) best = { element, score };
  }
  return best?.element || (document.scrollingElement as HTMLElement | null) || document.documentElement;
}

function visibleScrollArea(element: HTMLElement): number {
  const view = element.ownerDocument.defaultView;
  if (!view || !element.isConnected || !isVisibleElement(element) || element.closest('[hidden],[inert],[aria-hidden="true"]')) return 0;
  const rect = element.getBoundingClientRect();
  let left = Math.max(rect.left, 0);
  let top = Math.max(rect.top, 0);
  let right = Math.min(rect.right, view.innerWidth);
  let bottom = Math.min(rect.bottom, view.innerHeight);
  let ancestor = element.parentElement;
  while (ancestor) {
    const style = view.getComputedStyle(ancestor);
    const bounds = ancestor.getBoundingClientRect();
    if (/auto|scroll|hidden|clip/.test(style.overflowX || style.overflow)) {
      left = Math.max(left, bounds.left);
      right = Math.min(right, bounds.right);
    }
    if (/auto|scroll|hidden|clip/.test(style.overflowY || style.overflow)) {
      top = Math.max(top, bounds.top);
      bottom = Math.min(bottom, bounds.bottom);
    }
    ancestor = ancestor.parentElement;
  }
  let area = Math.max(0, right - left) * Math.max(0, bottom - top);
  if (view !== window) {
    const frame = view.frameElement;
    if (!frame || !isHtmlElement(frame)) return 0;
    area = Math.min(area, visibleScrollArea(frame));
  }
  return area;
}

function collectDomContexts(): DomContextCollection {
  const contexts: DomRootContext[] = [];
  const frames: PageFrameInfo[] = [];
  const seenRoots = new WeakSet<QueryRoot>();

  const addRoot = (context: DomRootContext): void => {
    if (contexts.length >= MAX_DOM_ROOTS || seenRoots.has(context.root)) {
      return;
    }

    seenRoots.add(context.root);
    contexts.push(context);
    collectNestedDomRoots(context);
  };

  const collectNestedDomRoots = (context: DomRootContext): void => {
    if (contexts.length >= MAX_DOM_ROOTS) {
      return;
    }

    for (const element of queryRoot(context.root, "*")) {
      const shadowRoot = element.shadowRoot;
      if (shadowRoot && context.shadowDepth < MAX_SHADOW_DEPTH) {
        addRoot({
          root: shadowRoot,
          frameContext: context.frameContext,
          rootContext: `${context.rootContext} > shadow:${describeRootHost(element)}`,
          frameDepth: context.frameDepth,
          shadowDepth: context.shadowDepth + 1
        });
      }

      if (isIframeElement(element) && context.frameDepth < MAX_FRAME_DEPTH) {
        const frameId = getOrCreateFrameId(element);
        const frameSrc = getFrameSource(element);
        try {
          const frameDocument = element.contentDocument;
          if (!frameDocument) {
            throw new Error("No accessible frame document.");
          }

          const frameUrl = getFrameDocumentUrl(frameDocument) || frameSrc;
          const frameLabel = `${frameId}${frameUrl ? ` ${frameUrl}` : ""}`;
          frames.push({
            id: frameId,
            title: frameDocument.title || undefined,
            url: frameUrl || undefined,
            accessible: true
          });

          addRoot({
            root: frameDocument,
            frameContext: frameLabel,
            rootContext: `iframe:${frameId}`,
            frameDepth: context.frameDepth + 1,
            shadowDepth: 0
          });
        } catch {
          frames.push({
            id: frameId,
            url: frameSrc || undefined,
            accessible: false,
            reason: "cross-origin or inaccessible iframe"
          });
        }
      }
    }
  };

  addRoot({
    root: document,
    rootContext: "document",
    frameDepth: 0,
    shadowDepth: 0
  });

  return { roots: contexts, frames };
}

function queryAllInContexts(contexts: DomContextCollection, selector: string): HTMLElement[] {
  const elements: HTMLElement[] = [];
  for (const context of contexts.roots) {
    for (const element of queryRoot(context.root, selector)) {
      rememberElementContext(element, context);
      elements.push(element);
    }
  }
  return elements;
}

function queryRoot(root: QueryRoot, selector: string): HTMLElement[] {
  try {
    return Array.from(root.querySelectorAll(selector)).filter(isHtmlElement);
  } catch {
    return [];
  }
}

function rememberElementContext(element: HTMLElement, context: DomRootContext): void {
  elementContexts.set(element, {
    frameContext: context.frameContext,
    rootContext: context.rootContext
  });
}

function getElementContext(element: HTMLElement): Pick<DomElementInfo, "frameContext" | "rootContext"> {
  return elementContexts.get(element) || {
    frameContext: getFrameContextFromOwnerDocument(element),
    rootContext: getRootContextFromElement(element)
  };
}

function describeRootHost(element: HTMLElement): string {
  const tag = element.tagName.toLowerCase();
  const id = element.id ? `#${element.id}` : "";
  const role = element.getAttribute("role");
  const roleLabel = role ? `[role=${role}]` : "";
  return `${tag}${id}${roleLabel}`;
}

function getFrameContextFromOwnerDocument(element: HTMLElement): string | undefined {
  const ownerWindow = element.ownerDocument.defaultView;
  if (!ownerWindow || ownerWindow === window) {
    return undefined;
  }

  try {
    return getFrameDocumentUrl(element.ownerDocument) || "nested frame";
  } catch {
    return "nested frame";
  }
}

function getRootContextFromElement(element: HTMLElement): string {
  const root = element.getRootNode();
  if (isShadowRoot(root)) {
    return `shadow:${describeRootHost(root.host as HTMLElement)}`;
  }
  return getFrameContextFromOwnerDocument(element) ? "iframe document" : "document";
}

function getOrCreateFrameId(element: Element): string {
  const existing = frameIds.get(element);
  if (existing) {
    return existing;
  }

  const id = `frame-${nextFrameId}`;
  nextFrameId += 1;
  frameIds.set(element, id);
  return id;
}

function getFrameSource(element: HTMLIFrameElement): string {
  return element.src || element.getAttribute("src") || "";
}

function getFrameDocumentUrl(frameDocument: Document): string {
  try {
    return frameDocument.location.href;
  } catch {
    return "";
  }
}

function getCandidateInteractiveElements(contexts = collectDomContexts()): HTMLElement[] {
  const candidates = new Set<HTMLElement>();

  for (const element of queryAllInContexts(contexts, interactiveSelector)) {
    candidates.add(element);
  }

  for (const editable of queryAllInContexts(contexts, textEditableSelector)) {
    if (!isVisibleElement(editable)) {
      continue;
    }

    candidates.add(editable);

    const wrapper = findLikelyEditableWrapper(editable);
    if (wrapper) {
      candidates.add(wrapper);
    }
  }

  for (const dragOrDropElement of queryAllInContexts(contexts, dragDropSelector)) {
    if (isVisibleElement(dragOrDropElement)) {
      candidates.add(dragOrDropElement);
    }
  }

  return Array.from(candidates);
}

export function getMappedElement(elementId: string): HTMLElement | undefined {
  return currentElements.get(elementId);
}

export function getDocumentId(): string {
  return documentId;
}

export function getFormStateFingerprint(): string {
  const controls = queryAllInContexts(collectDomContexts(), "input,textarea,select,[contenteditable='true']")
    .filter((element) => !isSensitiveElement(element));
  return hashText(JSON.stringify(controls.map((element) => [getOrCreateElementId(element), getSafeValue(element), getCheckedState(element),
    isDisabled(element), element.getAttribute("readonly"), element.getAttribute("aria-readonly")])));
}

export function getElementFingerprint(element: HTMLElement): string {
  const scope = element.closest("form,dialog,[role='dialog'],li,tr,[role='row']") || element.parentElement;
  return String(hashText(JSON.stringify([
    getOrCreateElementId(element), element.tagName, element.getAttribute("role"), getElementLabel(element),
    getElementText(element), isSensitiveElement(element) ? undefined : getSafeValue(element), getCheckedState(element),
    element.getAttribute("href"), element.getAttribute("type"), element.getAttribute("aria-expanded"),
    element.getAttribute("aria-selected"), element.getAttribute("readonly"), element.getAttribute("aria-readonly"),
    isDisabled(element), scope?.textContent?.slice(0, 1_000),
    isSelectElement(element) ? Array.from(element.options).map((option) => [option.value, option.text, option.disabled, option.selected]) : undefined,
  ])));
}

export function findMappedElementReplacement(elementId: string): HTMLElement | undefined {
  const snapshot = currentElementInfo.get(elementId) || historicalElementInfo.get(elementId);
  if (!snapshot) {
    return undefined;
  }

  observePage();

  const refreshedElement = currentElements.get(elementId);
  if (refreshedElement?.isConnected) {
    return refreshedElement;
  }

  const contexts = collectDomContexts();
  let bestMatch: { element: HTMLElement; score: number; tiedMatches: number } | undefined;
  for (const candidate of getCandidateInteractiveElements(contexts).filter(isVisibleElement)) {
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
  const contexts = collectDomContexts();
  return {
    url: location.href,
    title: document.title,
    headings: queryAllInContexts(contexts, "h1,h2,h3")
      .map((heading) => normalizeText(heading.textContent || ""))
      .filter(Boolean)
      .slice(0, 40),
    links: queryAllInContexts(contexts, "a[href]")
      .filter(isVisibleElement)
      .map((link) => ({
        text: normalizeText(link.innerText || link.textContent || getElementHref(link) || ""),
        href: getElementHref(link) || ""
      }))
      .filter((link) => link.text || link.href)
      .slice(0, 80),
    tables: extractTables(contexts),
    forms: extractForms(contexts),
    text: getReadableText(contexts)
  };
}

function toElementInfo(element: HTMLElement): DomElementInfo {
  const id = getOrCreateElementId(element);
  currentElements.set(id, element);

  const tag = element.tagName.toLowerCase();
  const elementContext = getElementContext(element);
  const input = isInputElement(element) ? element : undefined;
  const select = isSelectElement(element) ? element : undefined;
  const nestedInput = input || getPrimaryTextEditableDescendant(element);
  const nestedSelect = select || getPrimarySelectDescendant(element);
  const questionContext = getElementQuestionContext(element);
  const isDraggable = isDraggableElement(element);
  const isDropTarget = isDropTargetElement(element);
  const sensitive = isSensitiveElement(element);

  const info: DomElementInfo = {
    id,
    fingerprint: getElementFingerprint(element),
    tag,
    frameContext: elementContext.frameContext,
    rootContext: elementContext.rootContext === "document" ? undefined : elementContext.rootContext,
    role: element.getAttribute("role") || implicitRole(element),
    type: input?.type || (isButtonElement(element) ? element.type : undefined),
    text: sensitive ? undefined : getElementText(element),
    label: getElementLabel(element),
    name: getFormName(element),
    placeholder: getPlaceholder(element),
    accept: getFileAccept(element),
    context: questionContext?.text,
    questionNumber: questionContext?.questionNumber,
    value: sensitive ? undefined : getSafeValue(element),
    checkedState: getCheckedState(element),
    href: isAnchorElement(element) ? element.href : undefined,
    options: nestedSelect ? Array.from(nestedSelect.options).filter((option) => !option.disabled && !option.closest("optgroup[disabled]")).map((option) => option.text || option.value).slice(0, 30) : undefined,
    isDraggable: isDraggable || undefined,
    isDropTarget: isDropTarget || undefined,
    isFocused: isElementFocused(element),
    isExpanded: element.hasAttribute("aria-expanded") ? element.getAttribute("aria-expanded") === "true" : undefined,
    isSelected: element.hasAttribute("aria-selected") ? element.getAttribute("aria-selected") === "true" : undefined,
    isReadOnly: element.hasAttribute("readonly") || element.getAttribute("aria-readonly") === "true" || nestedInput?.hasAttribute("readonly") || undefined,
    isDisabled: isDisabled(element),
    isSensitive: sensitive
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
  if (snapshot.frameContext && snapshot.frameContext === candidate.frameContext) {
    score += 4;
  }
  if (snapshot.rootContext && snapshot.rootContext === candidate.rootContext) {
    score += 3;
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

function getReadableText(contexts = collectDomContexts()): string {
  const viewportText = getScrollAwareReadableText(contexts);
  if (viewportText) {
    return viewportText;
  }

  const text = normalizeText(
    contexts.roots
      .map((context) => getRootReadableText(context.root))
      .filter(Boolean)
      .join("\n")
  );
  return text.slice(0, MAX_PAGE_TEXT_CHARS);
}

function getScrollAwareReadableText(contexts: DomContextCollection): string {
  const textBlocks = queryAllInContexts(contexts, READABLE_TEXT_SELECTOR)
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

function getRootReadableText(root: QueryRoot): string {
  if (isDocumentRoot(root)) {
    return root.body?.innerText || root.documentElement?.textContent || "";
  }

  return root.textContent || "";
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
  if (isInputElement(element) || isTextAreaElement(element) || isSelectElement(element)) {
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
      .map((id) => getElementByIdNear(element, id)?.textContent || "")
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
    isInputElement(element) ||
    isTextAreaElement(element) ||
    isSelectElement(element)
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
    isInputElement(element) ||
    isTextAreaElement(element) ||
    isSelectElement(element) ||
    isButtonElement(element)
  ) {
    return element.name || undefined;
  }

  const nestedEditable = getPrimaryTextEditableDescendant(element);
  if (
    nestedEditable &&
    (isInputElement(nestedEditable) ||
      isTextAreaElement(nestedEditable) ||
      isSelectElement(nestedEditable))
  ) {
    return nestedEditable.name || undefined;
  }

  return undefined;
}

function getPlaceholder(element: HTMLElement): string | undefined {
  if (isInputElement(element) || isTextAreaElement(element)) {
    return element.placeholder || undefined;
  }

  const nestedEditable = getPrimaryTextEditableDescendant(element);
  if (nestedEditable && (isInputElement(nestedEditable) || isTextAreaElement(nestedEditable))) {
    return nestedEditable.placeholder || undefined;
  }

  return undefined;
}

function getFileAccept(element: HTMLElement): string | undefined {
  const fileInput = isInputElement(element) && element.type === "file" ? element : queryDescendants(element, "input[type='file']").find(isInputElement);
  const accept = fileInput?.accept || fileInput?.getAttribute("accept") || "";
  return accept ? accept.slice(0, 160) : undefined;
}

function getSafeValue(element: HTMLElement): string | undefined {
  if (isSensitiveElement(element)) return undefined;
  if (isTextAreaElement(element)) return element.value.slice(0, 160) || undefined;
  if (element.isContentEditable) return element.textContent?.slice(0, 160) || undefined;
  if (isSelectElement(element)) {
    return element.selectedOptions[0]?.text || element.value || undefined;
  }

  if (isInputElement(element) && (element.type === "checkbox" || element.type === "radio")) {
    const state = element.checked ? "checked" : "unchecked";
    return element.value ? `${element.value} (${state})` : state;
  }

  if (isInputElement(element) && element.value && !["password", "file"].includes(element.type)) {
    return element.value.slice(0, 160);
  }

  const nestedEditable = getPrimaryTextEditableDescendant(element);
  if (nestedEditable && nestedEditable !== element) {
    return getSafeValue(nestedEditable);
  }

  return undefined;
}

function getCheckedState(element: HTMLElement): "checked" | "unchecked" | "mixed" | undefined {
  if (isInputElement(element) && (element.type === "checkbox" || element.type === "radio")) {
    return element.checked ? "checked" : "unchecked";
  }

  const nestedChoice = queryDescendants(element, "input[type='checkbox'],input[type='radio']").find(isInputElement);
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

  const boundary = findQuestionContextBoundary(element) || getRootTextBoundary(element);
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
    isInputElement(element) ||
    isTextAreaElement(element) ||
    isSelectElement(element) ||
    isLabelElement(element) ||
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
  const rootBoundary = getRootBoundaryElement(element);

  while (current && current !== rootBoundary && depth < 10) {
    const text = normalizeText(current.innerText || current.textContent || "");
    if (/Problem Statement\s+\d+/i.test(text)) {
      return current;
    }

    current = current.parentElement;
    depth += 1;
  }

  return undefined;
}

function getTextBeforeElement(boundary: HTMLElement | ShadowRoot, element: HTMLElement): string {
  try {
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(boundary);
    range.setEndBefore(element);
    const text = normalizeText(range.toString());
    range.detach();
    return text;
  } catch {
    return normalizeText("innerText" in boundary ? boundary.innerText || "" : boundary.textContent || "");
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
  if (isButtonElement(element)) {
    return "button";
  }
  if (isAnchorElement(element)) {
    return "link";
  }
  if (isLabelElement(element)) {
    return "label";
  }
  if (isSelectElement(element)) {
    return "combobox";
  }
  if (isTextAreaElement(element)) {
    return "textbox";
  }
  if (isInputElement(element)) {
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
    isButtonElement(element) ||
    isInputElement(element) ||
    isTextAreaElement(element) ||
    isSelectElement(element)
  ) {
    return element.disabled;
  }

  const nestedEditable = getPrimaryTextEditableDescendant(element);
  if (
    nestedEditable &&
    (isInputElement(nestedEditable) ||
      isTextAreaElement(nestedEditable) ||
      isSelectElement(nestedEditable))
  ) {
    return nestedEditable.disabled;
  }

  return element.getAttribute("aria-disabled") === "true";
}

export function isSensitiveElement(element: HTMLElement): boolean {
  const controls = [element, ...element.querySelectorAll("input,textarea,[contenteditable='true']")];
  return controls.some((control) => {
    if (control.getAttribute("type")?.toLowerCase() === "password") return true;
    const autocomplete = (control.getAttribute("autocomplete") || "").toLowerCase();
    if (/(?:^|\s)(?:current-password|new-password|one-time-code|cc-[\w-]+)(?:\s|$)/.test(autocomplete)) return true;
    const identity = [control.id, control.getAttribute("name"), control.getAttribute("aria-label"), control.getAttribute("placeholder")]
      .filter(Boolean).join(" ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    return /password|passphrase|one.?time.?code|\botp\b|\b(?:cvv|cvc|ssn)\b|credit.?card|card.?number|social.?security|api.?key|private.?key|secret|auth.?token/.test(identity);
  });
}

function getPrimaryTextEditableDescendant(element: HTMLElement): HTMLElement | undefined {
  const editable = queryDescendants(element, textEditableSelector)[0];
  return editable && isVisibleElement(editable) ? editable : undefined;
}

function getPrimarySelectDescendant(element: HTMLElement): HTMLSelectElement | undefined {
  const select = queryDescendants(element, "select").find(isSelectElement);
  return select && isVisibleElement(select) ? select : undefined;
}

function findLikelyEditableWrapper(editable: HTMLElement): HTMLElement | undefined {
  let current = editable.parentElement;
  let depth = 0;

  const rootBoundary = getRootBoundaryElement(editable);
  while (current && current !== rootBoundary && depth < 5) {
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
    isLabelElement(element) ||
    role === "textbox" ||
    role === "combobox" ||
    element.tabIndex >= 0 ||
    element.hasAttribute("onclick") ||
    /InputBase|OutlinedInput|FilledInput|FormControl|Autocomplete|Select|TextField|field|input|control/i.test(className)
  );
}

function isElementFocused(element: HTMLElement): boolean {
  const activeElement = element.ownerDocument.activeElement;
  return activeElement === element || Boolean(activeElement && element.contains(activeElement));
}

function isVisibleElement(element: Element): element is HTMLElement {
  if (!isHtmlElement(element)) {
    return false;
  }

  const style = (element.ownerDocument.defaultView || window).getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function extractTables(contexts = collectDomContexts()): ExtractedPageData["tables"] {
  return queryAllInContexts(contexts, "table")
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

function extractForms(contexts = collectDomContexts()): ExtractedPageData["forms"] {
  return queryAllInContexts(contexts, "form")
    .filter(isVisibleElement)
    .slice(0, 10)
    .map((form) => {
      const controls = queryDescendants(form, interactiveSelector)
        .filter(isVisibleElement)
        .slice(0, 40)
        .map(toElementInfo);
      const labels = controls.map((control) => control.label || control.text || control.placeholder || "").filter(Boolean);
      return { labels, controls };
    });
}

function queryDescendants(element: HTMLElement, selector: string): HTMLElement[] {
  const results: HTMLElement[] = [];

  try {
    results.push(...Array.from(element.querySelectorAll(selector)).filter(isHtmlElement));
  } catch {
    return results;
  }

  collectShadowDescendants(element, selector, results, 0);
  return results;
}

function collectShadowDescendants(
  rootElement: HTMLElement,
  selector: string,
  results: HTMLElement[],
  depth: number
): void {
  if (depth >= MAX_SHADOW_DEPTH) {
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

function getElementByIdNear(element: HTMLElement, id: string): HTMLElement | undefined {
  const root = element.getRootNode();
  const found =
    isDocumentRoot(root) ? root.getElementById(id) : isShadowRoot(root) ? root.getElementById(id) : element.ownerDocument.getElementById(id);
  return found && isHtmlElement(found) ? found : undefined;
}

function getElementHref(element: HTMLElement): string | undefined {
  return isAnchorElement(element) ? element.href : element.getAttribute("href") || undefined;
}

function getRootTextBoundary(element: HTMLElement): HTMLElement | ShadowRoot {
  const root = element.getRootNode();
  if (isShadowRoot(root)) {
    return root;
  }
  if (isDocumentRoot(root)) {
    return root.body || root.documentElement;
  }
  return document.body || document.documentElement;
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

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
