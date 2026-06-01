import { buildAgentMessages } from "./prompts";
import { getActiveTab, notifySidePanel, sendTabMessage, sleep, tryInjectContentScript } from "./chromeAsync";
import { ModelClientError, requestAgentStep } from "./modelClient";
import { validateAgentAction } from "./safety";
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
        logs: logs.filter((entry) => !isLegacyApprovalLog(entry.message))
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
    for (let step = 1; step <= settings.maxSteps; step += 1) {
      if (isStopped(taskId)) {
        break;
      }

      const observation = await observePage(tab.id);
      appendLog("info", `Observed page: ${observation.title || observation.url}`);

      const modelResponse = await requestAgentStep(
        settings,
        buildAgentMessages({ task, observation, step, maxSteps: settings.maxSteps, previousResult })
      );

      appendLog("info", `${modelResponse.thought_summary} Next: ${formatAction(modelResponse.action)}.`);

      const decision = validateAgentAction({ modelResponse, task, observation });
      if (!decision.allowed) {
        appendLog("error", decision.reason);
        break;
      }

      const loopResult = await handleValidatedAction(tab.id, modelResponse);
      previousResult = loopResult.message;
      appendLog(loopResult.ok ? "success" : "error", loopResult.message);

      if (loopResult.shouldStop || !loopResult.ok || isStopped(taskId)) {
        break;
      }

      await sleep(modelResponse.action.type === "navigate" ? 1500 : 450);
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

async function handleValidatedAction(
  tabId: number,
  modelResponse: AgentModelResponse
): Promise<{ ok: boolean; message: string; shouldStop: boolean }> {
  const action = modelResponse.action;

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
    shouldStop: false
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
  if (isLegacyApprovalLog(message)) {
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

function isLegacyApprovalLog(message: string): boolean {
  return /This page appears to be an assessment|Waiting for|model marked this action as high risk|This looks like a quiz|This looks like a payment/i.test(
    message
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

function formatAction(action: AgentAction): string {
  if (action.type === "type") {
    return `type into ${action.elementId || "element"}`;
  }
  if (action.type === "select") {
    return `select on ${action.elementId || "element"}`;
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

function getErrorMessage(error: unknown): string {
  if (error instanceof ModelClientError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
