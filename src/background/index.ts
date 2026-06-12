import { buildAgentMessages } from "./prompts";
import { getActiveTab, notifySidePanel, sendTabMessage, sleep, tryInjectContentScript } from "./chromeAsync";
import { ModelClientError, requestAgentStep } from "./modelClient";

import { MAX_LOG_ENTRIES } from "../shared/defaults";
import { createId } from "../shared/ids";
import { loadSettings } from "../shared/storage";
import type {
  AgentAction,
  AgentLogEntry,
  AgentModelResponse,
  BackgroundToSidePanelMessage,
  ContentActionResult,
  PageObservation,
  SidePanelToBackgroundMessage
} from "../shared/types";

interface RunningSession {
  taskId: string;
  tabId: number;
  stopped: boolean;
}

let runningSession: RunningSession | undefined;
let logs: AgentLogEntry[] = [];

const SIDE_PANEL_PATH = "sidepanel.html";
const MAX_ACTIONS_PER_AGENT_STEP = 5;

configureSidePanelSafely();

chrome.runtime.onInstalled.addListener(() => {
  configureSidePanelSafely();
});

chrome.runtime.onStartup.addListener(() => {
  configureSidePanelSafely();
});

chrome.action.onClicked.addListener((tab) => {
  void openSidePanel(tab);
});

chrome.runtime.onMessage.addListener((message: SidePanelToBackgroundMessage, _sender, sendResponse) => {
  void handleRuntimeMessage(message)
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({ ok: false, error: getErrorMessage(error) });
    });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (runningSession?.tabId === tabId) {
    stopCurrentTask("The tab was closed.");
  }
});

function configureSidePanelSafely(): void {
  void configureSidePanel().catch((error: unknown) => {
    console.warn("Could not configure side panel.", error);
  });
}

async function configureSidePanel(): Promise<void> {
  if (!chrome.sidePanel) {
    return;
  }

  // MV3 side panels are browser-owned UI. We only register the extension page and
  // toolbar behavior; Chrome/Edge owns the panel host, position, and width.
  if (chrome.sidePanel.setOptions) {
    await chrome.sidePanel.setOptions({ path: SIDE_PANEL_PATH, enabled: true });
  }

  if (chrome.sidePanel.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
}

async function openSidePanel(tab: chrome.tabs.Tab): Promise<void> {
  if (!chrome.sidePanel?.open) {
    return;
  }

  if (typeof tab.windowId === "number") {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
}

async function handleRuntimeMessage(message: SidePanelToBackgroundMessage): Promise<unknown> {
  switch (message.type) {
    case "SIDEPANEL_RUN_TASK":
      void startTask(message.task);
      return { ok: true };

    case "SIDEPANEL_STOP_TASK":
      stopCurrentTask("Stopped by user.");
      return { ok: true };

    case "SIDEPANEL_GET_STATE":
      return {
        running: Boolean(runningSession && !runningSession.stopped),
        logs: logs.filter((entry) => !isHiddenActionLog(entry.message))
      };

    default:
      return { ok: false, error: "Unsupported message." };
  }
}

async function startTask(task: string): Promise<void> {
  if (!task.trim()) {
    appendLog("warning", "Enter a task first.");
    return;
  }

  if (runningSession) {
    stopCurrentTask("Starting a new task.");
  }

  const taskId = createId("task");
  try {
    const settings = await loadSettings();
    if (!settings.apiKey.trim()) {
      appendLog("error", "Add an API key in Settings before running a task.");
      return;
    }
    if (!settings.model.trim()) {
      appendLog("error", "Add a model name in Settings before running a task.");
      return;
    }

    const tab = await getActiveTab();
    if (!tab?.id || !isSupportedTabUrl(tab.url)) {
      appendLog("error", "Open an http(s) webpage before running the agent. Browser internal pages are blocked.");
      return;
    }

    runningSession = { taskId, tabId: tab.id, stopped: false };
    emitStatus();
    appendLog("info", `Task started on ${new URL(tab.url).hostname}.`);

    let previousResult: string | undefined;
    const completedInputActions = new Set<string>();
    for (let step = 1; step <= settings.maxSteps; step += 1) {
      if (isStopped(taskId)) {
        break;
      }

      const observation = await observePage(tab.id);
      appendLog("info", `Observed page: ${observation.title || observation.url}`);

      const messages = buildAgentMessages({ task, observation, step, maxSteps: settings.maxSteps, previousResult });
      logPromptBeforeModelCall(step, messages);

      const modelResponse = await requestAgentStep(settings, messages);
      const plannedActions = getPlannedActions(modelResponse);

      appendLog("info", `${modelResponse.thought_summary} Next: ${formatActions(plannedActions)}.`);

      // Safety checks removed — all actions proceed unconditionally.

      const loopResult = await handlePlannedActions(tab.id, modelResponse, plannedActions, completedInputActions, taskId);
      previousResult = loopResult.message;
      appendLog(loopResult.ok ? "success" : loopResult.recoverable ? "warning" : "error", loopResult.message);

      if (loopResult.shouldStop || (!loopResult.ok && !loopResult.recoverable) || isStopped(taskId)) {
        break;
      }

      await sleep(getPostBatchDelay(plannedActions));
    }

    if (!isStopped(taskId)) {
      appendLog("info", "Task loop finished.");
    }
  } catch (error) {
    appendLog("error", getErrorMessage(error));
  } finally {
    if (runningSession?.taskId === taskId) {
      runningSession = undefined;
      emitStatus();
    }
  }
}

interface ActionLoopResult {
  ok: boolean;
  message: string;
  shouldStop: boolean;
  recoverable?: boolean;
}

async function handlePlannedActions(
  tabId: number,
  modelResponse: AgentModelResponse,
  actions: AgentAction[],
  completedInputActions: Set<string>,
  taskId: string
): Promise<ActionLoopResult> {
  const messages: string[] = [];

  for (let index = 0; index < actions.length; index += 1) {
    if (isStopped(taskId)) {
      return {
        ok: true,
        message: messages.join(" ") || "Stopped by user.",
        shouldStop: true
      };
    }

    const action = actions[index];
    const duplicateInputAction = getDuplicateInputAction(action, completedInputActions);
    if (duplicateInputAction) {
      const duplicateResult = await handleDuplicateInputAction(tabId, action, duplicateInputAction);
      messages.push(formatActionResult(index, actions.length, duplicateResult.message));
      if (!duplicateResult.ok || duplicateResult.recoverable) {
        return {
          ok: duplicateResult.ok,
          recoverable: duplicateResult.recoverable,
          message: messages.join(" "),
          shouldStop: false
        };
      }
      await sleep(160);
      continue;
    }

    const result = await handleSingleAction(tabId, modelResponse, action);
    messages.push(formatActionResult(index, actions.length, result.message));

    if (result.ok) {
      rememberCompletedInputAction(action, completedInputActions);
    }

    if (result.shouldStop || !result.ok) {
      return {
        ...result,
        message: messages.join(" ")
      };
    }

    if (shouldHaltBatchAfterAction(action)) {
      if (index < actions.length - 1) {
        messages.push("Paused the remaining batch until the next page observation.");
      }
      break;
    }

    await sleep(getInterActionDelay(action));
  }

  return {
    ok: true,
    message: messages.join(" "),
    shouldStop: false
  };
}

async function handleSingleAction(
  tabId: number,
  modelResponse: AgentModelResponse,
  action: AgentAction
): Promise<ActionLoopResult> {
  if (action.type === "done") {
    return {
      ok: true,
      message: action.text || modelResponse.thought_summary || "Done.",
      shouldStop: true
    };
  }

  if (action.type === "ask_user") {
    return {
      ok: true,
      message: action.text || modelResponse.thought_summary || "The agent needs input from you.",
      shouldStop: true
    };
  }

  const result = await executeAction(tabId, action);
  return {
    ok: result.ok,
    message: result.message,
    shouldStop: false,
    recoverable: result.recoverable
  };
}

async function observePage(tabId: number): Promise<PageObservation> {
  try {
    return await sendTabMessage<PageObservation>(tabId, { type: "CONTENT_OBSERVE" });
  } catch (firstError) {
    try {
      await tryInjectContentScript(tabId);
      await sleep(250);
      return await sendTabMessage<PageObservation>(tabId, { type: "CONTENT_OBSERVE" });
    } catch {
      throw new Error(
        `Could not read this page. It may be a browser page, protected store page, PDF, or missing host permission. ${getErrorMessage(
          firstError
        )}`
      );
    }
  }
}

async function executeAction(tabId: number, action: AgentAction): Promise<ContentActionResult> {
  try {
    return await sendTabMessage<ContentActionResult>(tabId, { type: "CONTENT_EXECUTE", action });
  } catch (error) {
    throw new Error(`Could not execute ${action.type}: ${getErrorMessage(error)}`);
  }
}

function stopCurrentTask(reason: string): void {
  if (runningSession && !runningSession.stopped) {
    runningSession.stopped = true;
    appendLog("warning", reason);
  }

  emitStatus();
}

function appendLog(level: AgentLogEntry["level"], message: string): void {
  if (isHiddenActionLog(message)) {
    return;
  }

  const entry: AgentLogEntry = {
    id: createId("log"),
    level,
    message,
    timestamp: Date.now()
  };

  logs = [...logs, entry].slice(-MAX_LOG_ENTRIES);
  notifySidePanel({ type: "AGENT_LOG", entry } satisfies BackgroundToSidePanelMessage);
}

function logPromptBeforeModelCall(step: number, messages: ReturnType<typeof buildAgentMessages>): void {
  console.groupCollapsed(`[BYOK Agent] Prompt messages for step ${step}`);
  console.info({ messages });
  console.info("Messages JSON:", JSON.stringify(messages, null, 2));
  console.groupEnd();
}

function isHiddenActionLog(message: string): boolean {
  return (
    message.startsWith("Prompt sent to AI") ||
    /This page appears to be an assessment|Waiting for|model marked this action as high risk|This looks like a quiz|This looks like a payment/i.test(
      message
    )
  );
}

function emitStatus(): void {
  notifySidePanel({
    type: "AGENT_STATUS",
    running: Boolean(runningSession && !runningSession.stopped),
    taskId: runningSession?.taskId
  } satisfies BackgroundToSidePanelMessage);
}

function isStopped(taskId: string): boolean {
  return !runningSession || runningSession.taskId !== taskId || runningSession.stopped;
}

function isSupportedTabUrl(url?: string): url is string {
  if (!url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function getPlannedActions(modelResponse: AgentModelResponse): AgentAction[] {
  const fallbackAction: AgentAction = { type: "done", text: "No action returned by the model." };
  const actions = modelResponse.actions?.length
    ? modelResponse.actions
    : modelResponse.action
      ? [modelResponse.action]
      : [fallbackAction];

  return actions.slice(0, MAX_ACTIONS_PER_AGENT_STEP);
}

function formatActions(actions: AgentAction[]): string {
  if (actions.length === 1) {
    return formatAction(actions[0]);
  }

  return `${actions.length} actions: ${actions.map(formatAction).join(" -> ")}`;
}

function formatAction(action: AgentAction): string {
  if (action.type === "multi_click") {
    return `select ${action.elementIds?.length || 0} options`;
  }
  if (action.type === "multi_drag") {
    return `drag ${action.dragPairs?.length || 0} pairs`;
  }
  if (action.type === "drag") {
    return `drag ${action.elementId || "source"} to ${action.targetElementId || "target"}`;
  }
  if (action.type === "fill") {
    return `fill ${action.elementId || "element"}`;
  }
  if (action.type === "type") {
    return `type into ${action.elementId || "element"}`;
  }
  if (action.type === "select") {
    return `select on ${action.elementId || "element"}`;
  }
  if (action.type === "press_key") {
    return `press ${action.key || action.text || "key"}`;
  }
  if (action.type === "click") {
    return `click ${action.elementId || "element"}`;
  }
  if (action.type === "navigate") {
    return `navigate to ${action.url || "URL"}`;
  }
  if (action.type === "scroll") {
    return `scroll ${action.direction || "down"}`;
  }
  return action.type;
}

function formatActionResult(index: number, total: number, message: string): string {
  return total > 1 ? `[${index + 1}/${total}] ${message}` : message;
}

function getPostBatchDelay(actions: AgentAction[]): number {
  return actions.some((action) => action.type === "navigate") ? 1500 : 450;
}

function getInterActionDelay(action: AgentAction): number {
  if (action.type === "navigate") {
    return 1200;
  }
  if (action.type === "drag" || action.type === "multi_drag") {
    return 300;
  }
  return 180;
}

function shouldHaltBatchAfterAction(action: AgentAction): boolean {
  return action.type === "navigate";
}

interface DuplicateInputAction {
  message: string;
  shouldAdvanceFocus: boolean;
}

async function handleDuplicateInputAction(
  tabId: number,
  action: AgentAction,
  duplicate: DuplicateInputAction
): Promise<{ ok: boolean; message: string; recoverable?: boolean }> {
  if (!duplicate.shouldAdvanceFocus) {
    return {
      ok: true,
      message: duplicate.message
    };
  }

  const advanceResult = await executeAction(tabId, {
    type: "press_key",
    key: "Tab",
    elementId: action.elementId
  });

  if (!advanceResult.ok) {
    return {
      ok: false,
      recoverable: advanceResult.recoverable,
      message: `${duplicate.message} Could not advance automatically: ${advanceResult.message}`
    };
  }

  return {
    ok: true,
    message: `${duplicate.message} Advanced to the next focusable field. ${advanceResult.message}`
  };
}

function getDuplicateInputAction(action: AgentAction, completedInputActions: Set<string>): DuplicateInputAction | undefined {
  const key = getInputActionKey(action);
  if (!key || !completedInputActions.has(key)) {
    return undefined;
  }

  if (action.type === "multi_click") {
    return {
      message: `Skipped repeated multi_click for ${action.elementIds?.length || 0} options; that option set was already handled.`,
      shouldAdvanceFocus: false
    };
  }

  if (action.type === "multi_drag") {
    return {
      message: `Skipped repeated multi_drag for ${action.dragPairs?.length || 0} pairs; that drag/drop set was already handled.`,
      shouldAdvanceFocus: false
    };
  }

  if (action.type === "drag") {
    return {
      message: `Skipped repeated drag from ${action.elementId} to ${action.targetElementId}; that drag/drop action was already handled.`,
      shouldAdvanceFocus: false
    };
  }

  return {
    message: `Skipped repeated ${action.type} on ${action.elementId}; that field was already handled.`,
    shouldAdvanceFocus: action.type === "fill" || action.type === "type"
  };
}

function rememberCompletedInputAction(action: AgentAction, completedInputActions: Set<string>): void {
  const key = getInputActionKey(action);
  if (key) {
    completedInputActions.add(key);
  }
}

function getInputActionKey(action: AgentAction): string | undefined {
  if (action.type === "multi_click") {
    return action.elementIds?.length ? `multi_click:${[...action.elementIds].sort().join(",")}` : undefined;
  }

  if (action.type === "multi_drag") {
    return action.dragPairs?.length
      ? `multi_drag:${action.dragPairs.map((pair) => `${pair.elementId}->${pair.targetElementId}`).join("|")}`
      : undefined;
  }

  if (action.type === "drag") {
    return action.elementId && action.targetElementId ? `drag:${action.elementId}->${action.targetElementId}` : undefined;
  }

  if ((action.type !== "fill" && action.type !== "type" && action.type !== "select") || !action.elementId) {
    return undefined;
  }

  if (action.type === "fill" || action.type === "type") {
    return `fill:${action.elementId}`;
  }

  if (typeof action.text !== "string") {
    return undefined;
  }

  return `select:${action.elementId}:${normalizeActionText(action.text)}`;
}

function normalizeActionText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function getErrorMessage(error: unknown): string {
  if (error instanceof ModelClientError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
