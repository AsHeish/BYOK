import type { AgentModelResponse, PageObservation } from "../shared/types";

export const AGENT_PROMPT_CACHE_VERSION = "byok-agent-prompt-v0.1.42";
const MAX_ACTIONS_PER_RESPONSE = 10;
const MAX_OBSERVATION_INPUT_TOKENS = 4000;
const APPROX_CHARS_PER_TOKEN = 4;
const MAX_OBSERVATION_CHARS = MAX_OBSERVATION_INPUT_TOKENS * APPROX_CHARS_PER_TOKEN;

export interface PromptTabInfo {
  alias: string;
  title?: string;
  url?: string;
  active: boolean;
}

export interface PromptStagedFileInfo {
  id: string;
  name: string;
  type: string;
  size: number;
}

export interface PromptDownloadInfo {
  id: number;
  filename?: string;
  url?: string;
  mime?: string;
  state?: string;
  totalBytes?: number;
  exists?: boolean;
}

export function buildAgentMessages(args: {
  task: string;
  observation: PageObservation;
  step: number;
  maxSteps: number;
  previousResult?: string;
  tabs?: PromptTabInfo[];
  activeTabAlias?: string;
  stagedFile?: PromptStagedFileInfo;
  downloads?: PromptDownloadInfo[];
}): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: [
        `Prompt cache version: ${AGENT_PROMPT_CACHE_VERSION}`,
        "You are a BYOK AI browser agent running inside a Chrome/Edge extension.",
        "Return strict JSON only. No markdown, code fences, or extra commentary.",
        "Choose the next browser action or a short ordered action batch. The extension executes actions in order, then observes again.",
        "",
        "For text fields, prefer fill over separate click and type actions. fill automatically clicks, focuses, and replaces the field value in one browser action.",
        "- For custom form controls, an outer div may represent a textbox. If it has role=textbox, a useful label, placeholder, value, or input-like class, use fill on that element; the extension will click/focus its nested input safely.",
        `- You may return actions instead of action when several UI steps can be done from the same current observation. Return at most ${MAX_ACTIONS_PER_RESPONSE} actions.`,
        "- The browser executes batches in fail-safe mode: it stops the remaining batch if an action fails, goes stale, asks the user, finishes, or navigates, then sends you the latest progress and page observation.",
        "- Good batches: fill an answer then click a visible Continue button; select several visible controls; drag several visible items to visible targets.",
        "- Use go_back when you need to return to the previous browser history page.",
        "- You can manage tracked browser tabs by alias. Use open_tab with url, switch_tab with tabAlias, close_tab with tabAlias, reload with optional tabAlias, and go_forward/go_back for browser history.",
        "- The full page observation is only for the active tab alias. To work on another tab, switch_tab first and wait for the next observation.",
        "- Page observations may include elements from accessible same-origin iframes and open shadow DOM roots. Use frame/root fields to distinguish repeated controls in embedded widgets.",
        "- Cross-origin iframes and closed shadow roots cannot be inspected directly. If a needed control is only inside an inaccessible frame/root, ask the user to open that frame/page directly or interact manually.",
        "- For controlled file uploads, use upload_file with elementId for the visible upload control or input[type=file]. It can only upload the single user-staged file shown in context; never invent local file paths.",
        "- If no staged file is available and the task needs an upload, use ask_user.",
        "- Use list_downloads to inspect recent browser downloads. Use summarize_pdf for PDFs from a staged file, a PDF URL, a downloadId, or the current PDF tab.",
        "- For a normal web page summary, use summarize_page or return done with the summary in action.text when the current observation already has enough text.",
        "- Do not batch actions after navigate, go_back, go_forward, reload, open_tab, switch_tab, close_tab, after a click that likely changes the page, after a final submit-like action, or when you need the next page observation to decide.",
        "- For drag-and-drop questions, use drag with elementId as the draggable source and targetElementId as the drop zone or destination. For several visible drag/drop pairs in the same question, prefer multi_drag with dragPairs.",
        "- If drag/drop source or target is unclear, use ask_user instead of guessing.",
        "- For multiple-answer checkbox or multi-select questions where several options are correct for the same question, use one multi_click action with elementIds containing all correct option element IDs. Do not call one click at a time for those options.",
        "- Use multi_click only for options that can be selected together. For single-answer radio questions, use one click for the single correct option.",
        "- When multiple fields have the same label, use each element's problem and context fields to decide which question it belongs to. Do not rely only on repeated labels like \"Your Submission\".",
        "- Do not copy the same option number into multiple questions unless each field's own context independently supports that answer.",
        "- Do not fill any field that already has a non-empty value in the observation, even if the value differs from the answer you planned. Move to the next empty field or finish.",
        "- If the previous action result says a field was skipped because it already has a value or was skipped and advanced, never retry that same element. Use the element marked focused=true, choose the next empty field, or return done.",
        "- The previous action result lists what was actually completed. Continue from the last completed action; do not repeat completed or skipped actions.",
        "- If the previous action result says the target element is no longer available, do not retry that stale elementId. Use the refreshed observation and pick a current element ID.",
        "- If the previous action result says the target is not editable, do not retry the same wrapper. Use the refreshed focused element or an empty fillable control from the page state summary.",
        "- If the previous action result says an action likely changed the page before the content script replied, treat it as a navigation/page-change recovery. Continue from the refreshed current page and do not repeat that click unless still visibly needed.",
        "- If the user asks to keep pressing Tab or move to the next input, use press_key with key=\"Tab\". The next observation will mark the newly focused element with focused=true.",
        "",
        "Allowed action schema:",
        "Return either action for one action or actions for an ordered batch. Do not include both unless actions is the intended plan.",
        "Action type must be one of: click, multi_click, drag, multi_drag, upload_file, fill, type, select, press_key, summarize_page, summarize_pdf, list_downloads, scroll, navigate, go_back, go_forward, reload, open_tab, switch_tab, close_tab, extract, ask_user, done.",
        `For action batches, set actions to an array of up to ${MAX_ACTIONS_PER_RESPONSE} action objects.`,
        "For multi_click, set elementIds to an array of the option IDs to select in the same browser action.",
        "For multi_drag, set dragPairs to an array of { elementId, targetElementId } pairs to drag in order.",
        "For drag, set elementId to the draggable source and targetElementId to the destination/drop zone.",
        "For upload_file, set elementId and optional fileId from the staged file context.",
        "For summarize_pdf, set url, fileId, or downloadId when known; otherwise it will try the current PDF tab, staged PDF, or latest PDF download.",
        "For list_downloads, optional maxItems controls the number of recent downloads to list.",
        "For fill and type, set elementId and text. Use fill for normal form input because it combines click/focus and typing.",
        "For press_key, set key to Tab or Shift+Tab.",
        "For go_back, no elementId or url is needed.",
        "For open_tab, set url. The new tab becomes active and receives the next tab alias.",
        "For switch_tab and close_tab, set tabAlias such as \"tab-2\". For reload, tabAlias is optional and defaults to the active tab.",
        JSON.stringify(exampleResponse(), null, 2)
      ].join("\n")
    },
    {
      role: "user",
      content: ["Stable task context for this agent run:", args.task].join("\n")
    },
    {
      role: "user",
      content: [
        `Step: ${args.step} of ${args.maxSteps}`,
        args.tabs?.length ? `Tracked browser tabs:\n${formatTabs(args.tabs, args.activeTabAlias)}` : "",
        args.stagedFile ? `Staged upload file:\n${formatStagedFile(args.stagedFile)}` : "Staged upload file: none",
        args.downloads?.length ? `Recent downloads:\n${formatDownloads(args.downloads)}` : "Recent downloads: none",
        args.previousResult ? `Previous action result: ${args.previousResult}` : "",
        "",
        `Current page observation${args.activeTabAlias ? ` for ${args.activeTabAlias}` : ""}:`,
        formatObservation(args.observation),
        "",
        "Return the next action JSON now."
      ]
        .filter(Boolean)
        .join("\n")
    }
  ];
}

function formatTabs(tabs: PromptTabInfo[], activeTabAlias?: string): string {
  return tabs
    .map((tab) => {
      const activeMarker = tab.active || tab.alias === activeTabAlias ? "active " : "";
      return `- ${tab.alias} ${activeMarker}title=${quote(tab.title || "Untitled", 90)} url=${quote(tab.url || "", 150)}`;
    })
    .join("\n");
}

function formatStagedFile(file: PromptStagedFileInfo): string {
  return `- fileId=${file.id} name=${quote(file.name, 120)} type=${quote(file.type || "application/octet-stream", 80)} size=${file.size}`;
}

function formatDownloads(downloads: PromptDownloadInfo[]): string {
  return downloads
    .map((download) => {
      const parts = [
        `downloadId=${download.id}`,
        download.filename ? `filename=${quote(getShortFilename(download.filename), 120)}` : "",
        download.mime ? `mime=${quote(download.mime, 80)}` : "",
        typeof download.totalBytes === "number" && download.totalBytes > 0 ? `bytes=${download.totalBytes}` : "",
        download.state ? `state=${download.state}` : "",
        typeof download.exists === "boolean" ? `exists=${download.exists}` : "",
        download.url ? `url=${quote(download.url, 180)}` : ""
      ].filter(Boolean);
      return `- ${parts.join(" ")}`;
    })
    .join("\n");
}

function exampleResponse(): AgentModelResponse {
  return {
    thought_summary: "short user-visible reasoning",
    risk_level: "low",
    actions: [
      {
        type: "fill",
        elementId: "el-1",
        text: "answer text"
      },
      {
        type: "click",
        elementId: "el-2"
      }
    ]
  };
}

function formatObservation(observation: PageObservation): string {
  const elementLines = observation.elements.map(formatElementLine);
  const stateSummary = formatObservationState(observation);
  const header = [`URL: ${observation.url}`, `Title: ${observation.title}`, stateSummary, "", "Readable text:"]
    .filter(Boolean)
    .join("\n");
  const elementHeader = "\n\nInteractive elements:\n";
  const reservedForElements = Math.min(7000, Math.max(2500, Math.floor(MAX_OBSERVATION_CHARS * 0.45)));
  const textBudget = Math.max(1200, MAX_OBSERVATION_CHARS - header.length - elementHeader.length - reservedForElements);
  const readableText = truncateByChars(observation.text, textBudget);
  const elementBudget = MAX_OBSERVATION_CHARS - header.length - readableText.length - elementHeader.length;
  const elements = fitLinesWithinBudget(elementLines, elementBudget) || "(none found)";

  return truncateByChars(`${header}\n${readableText}${elementHeader}${elements}`, MAX_OBSERVATION_CHARS);
}

function formatObservationState(observation: PageObservation): string {
  const focusedElement = observation.elements.find((element) => element.isFocused);
  const emptyFillableElements = observation.elements
    .filter((element) => isLikelyFillableElement(element) && !hasCompletedControlValue(element) && !element.isDisabled)
    .slice(0, 14);
  const completedControls = observation.elements
    .filter((element) => hasCompletedControlValue(element))
    .slice(0, 14);
  const dragDropElements = observation.elements
    .filter((element) => element.isDraggable || element.isDropTarget)
    .slice(0, 14);
  const fileUploadElements = observation.elements
    .filter(isLikelyFileUploadElement)
    .slice(0, 10);

  return [
    "Page state summary:",
    formatViewportState(observation),
    formatFrameState(observation),
    "Element IDs are current only for this observation. Use the IDs below, not stale IDs from earlier steps.",
    focusedElement ? `Focused element: ${formatCompactElementRef(focusedElement)}` : "",
    emptyFillableElements.length
      ? `Empty fillable controls: ${emptyFillableElements.map((element) => formatCompactElementRef(element)).join(" | ")}`
      : "Empty fillable controls: none visible",
    completedControls.length
      ? `Already filled/selected controls: ${completedControls.map((element) => formatCompactElementRef(element, true)).join(" | ")}`
      : "",
    dragDropElements.length
      ? `Drag/drop candidates: ${dragDropElements.map((element) => formatCompactElementRef(element)).join(" | ")}`
      : "",
    fileUploadElements.length
      ? `File upload controls: ${fileUploadElements.map((element) => formatCompactElementRef(element)).join(" | ")}`
      : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function formatViewportState(observation: PageObservation): string {
  const viewport = observation.viewport;
  if (!viewport) {
    return "";
  }

  return `Viewport: ${viewport.viewportWidth}x${viewport.viewportHeight}, scrollY=${viewport.scrollY}, pageHeight=${viewport.pageHeight}, pageProgress=${viewport.progressPercent}%`;
}

function formatFrameState(observation: PageObservation): string {
  if (!observation.frames?.length) {
    return "";
  }

  const frames = observation.frames
    .slice(0, 12)
    .map((frame) => {
      const status = frame.accessible ? "accessible" : `inaccessible:${frame.reason || "unknown"}`;
      const label = frame.title || frame.url || "";
      return `${frame.id} ${status}${label ? ` ${quote(label, 120)}` : ""}`;
    })
    .join(" | ");

  return `Frames: ${frames}`;
}

function formatCompactElementRef(element: PageObservation["elements"][number], includeValue = false): string {
  const descriptor = element.label || element.placeholder || element.text || element.name || element.role || element.tag;
  const parts = [
    element.id,
    element.frameContext ? `frame=${quote(element.frameContext, 90)}` : "",
    element.rootContext ? `root=${quote(element.rootContext, 90)}` : "",
    element.questionNumber ? `problem=${element.questionNumber}` : "",
    descriptor ? `label=${quote(descriptor, 90)}` : "",
    element.accept ? `accept=${quote(element.accept, 80)}` : "",
    element.isFocused ? "focused=true" : "",
    element.isDraggable ? "draggable=true" : "",
    element.isDropTarget ? "dropTarget=true" : "",
    includeValue && element.value ? `value=${quote(element.value, 80)}` : "",
    includeValue && element.checkedState ? `checkedState=${element.checkedState}` : ""
  ].filter(Boolean);

  return parts.join(" ");
}

function isLikelyFillableElement(element: PageObservation["elements"][number]): boolean {
  if (element.checkedState || element.href || element.isDraggable || element.isDropTarget) {
    return false;
  }

  if (element.type && /^(button|submit|reset|checkbox|radio|file|hidden)$/i.test(element.type)) {
    return false;
  }

  if (element.tag === "input" || element.tag === "textarea" || element.tag === "select") {
    return true;
  }

  if (element.role === "textbox" || element.role === "combobox") {
    return true;
  }

  if (element.options?.length) {
    return true;
  }

  const descriptor = [element.label, element.placeholder, element.text, element.context].filter(Boolean).join(" ");
  return /answer|submission|input|field|textbox|response|option number/i.test(descriptor);
}

function isLikelyFileUploadElement(element: PageObservation["elements"][number]): boolean {
  if (element.type === "file" || element.accept) {
    return true;
  }

  const descriptor = [element.label, element.placeholder, element.text, element.context, element.name].filter(Boolean).join(" ");
  return /upload|attach|choose file|select file|drop file|browse/i.test(descriptor);
}

function hasCompletedControlValue(element: PageObservation["elements"][number]): boolean {
  if (element.checkedState) {
    return element.checkedState === "checked" || element.checkedState === "mixed";
  }

  return Boolean(element.value && !/\bunchecked\)?$/i.test(element.value.trim()));
}

function formatElementLine(element: PageObservation["elements"][number]): string {
  const parts = [
    `id=${element.id}`,
    `tag=${element.tag}`,
    element.frameContext ? `frame=${quote(element.frameContext, 120)}` : "",
    element.rootContext ? `root=${quote(element.rootContext, 120)}` : "",
    element.role ? `role=${element.role}` : "",
    element.type ? `type=${element.type}` : "",
    element.label ? `label=${quote(element.label)}` : "",
    element.text ? `text=${quote(element.text)}` : "",
    element.placeholder ? `placeholder=${quote(element.placeholder)}` : "",
    element.accept ? `accept=${quote(element.accept)}` : "",
    element.questionNumber ? `problem=${element.questionNumber}` : "",
    element.context ? `context=${quote(element.context, 420)}` : "",
    element.value ? `value=${quote(element.value)}` : "",
    element.checkedState ? `checkedState=${element.checkedState}` : "",
    element.href ? `href=${quote(element.href)}` : "",
    element.options?.length ? `options=${quote(element.options.join(" | "))}` : "",
    element.isDraggable ? "draggable=true" : "",
    element.isDropTarget ? "dropTarget=true" : "",
    element.isFocused ? "focused=true" : "",
    element.isDisabled ? "disabled=true" : ""
  ].filter(Boolean);

  return `- ${parts.join(" ")}`;
}

function fitLinesWithinBudget(lines: string[], budget: number): string {
  const selected: string[] = [];
  let used = 0;

  for (const line of lines) {
    const cost = line.length + 1;
    if (used + cost > budget) {
      break;
    }
    selected.push(line);
    used += cost;
  }

  return selected.join("\n");
}

function truncateByChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 28))}\n[truncated to prompt budget]`;
}

function quote(value: string, maxLength = 180): string {
  return JSON.stringify(value.slice(0, maxLength));
}

function getShortFilename(filename: string): string {
  return filename.split(/[\\/]/).pop() || filename;
}
