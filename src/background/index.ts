import { buildAgentMessages, type PromptTabInfo } from "./prompts";
import { getActiveTab, notifySidePanel, sendTabMessage, sleep, tryInjectContentScript } from "./chromeAsync";
import { ModelClientError, requestAgentStep } from "./modelClient";
import { extractPdfText } from "./pdfText";

import { dataUrlToUint8Array, formatFileSize } from "../shared/fileData";
import { MAX_LOG_ENTRIES } from "../shared/defaults";
import { createId } from "../shared/ids";
import { loadSettings, loadStagedUploadFile } from "../shared/storage";
import type {
  AgentAction,
  AgentLogEntry,
  AgentModelResponse,
  AgentUsageSnapshot,
  BackgroundToSidePanelMessage,
  ContentActionResult,
  ModelUsageEvent,
  PageObservation,
  SidePanelToBackgroundMessage,
  StagedUploadFile
} from "../shared/types";

interface RunningSession {
  taskId: string;
  activeTabId: number;
  activeTabAlias: string;
  tabs: AgentTabState[];
  nextTabNumber: number;
  stopped: boolean;
}

interface AgentTabState {
  alias: string;
  tabId: number;
  windowId?: number;
  title?: string;
  url?: string;
  active: boolean;
  createdAt: number;
  lastObservedAt?: number;
}

let runningSession: RunningSession | undefined;
let logs: AgentLogEntry[] = [];
let usageSnapshot: AgentUsageSnapshot = createEmptyUsageSnapshot();

const SIDE_PANEL_PATH = "sidepanel.html";
const MAX_ACTIONS_PER_AGENT_STEP = 10;
const MAX_PROGRESS_LINES_FOR_PROMPT = 30;
const MAX_ACTION_LOG_PREVIEW = 20;
const TAB_SETTLE_TIMEOUT_MS = 5000;
const MAX_SUMMARY_INPUT_CHARS = 30000;
const MAX_DOWNLOADS_FOR_PROMPT = 5;

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
  if (!runningSession?.tabs.some((tab) => tab.tabId === tabId)) {
    return;
  }

  const closedTab = runningSession.tabs.find((tab) => tab.tabId === tabId);
  runningSession.tabs = runningSession.tabs.filter((tab) => tab.tabId !== tabId);
  if (runningSession.activeTabId === tabId) {
    const fallbackTab = runningSession.tabs[0];
    if (!fallbackTab) {
      stopCurrentTask(`Tracked tab ${closedTab?.alias || tabId} was closed.`);
      return;
    }
    setActiveTrackedTab(runningSession, fallbackTab);
    appendLog("warning", `Active tab ${closedTab?.alias || tabId} was closed. Switched tracking to ${fallbackTab.alias}.`);
  }
});

if (chrome.downloads?.onChanged) {
  chrome.downloads.onChanged.addListener((delta) => {
    if (delta.state?.current === "complete") {
      void logCompletedDownload(delta.id);
    }
  });
}

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
        logs: logs.filter((entry) => !isHiddenActionLog(entry.message)),
        usage: usageSnapshot
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

    runningSession = createRunningSession(taskId, tab);
    usageSnapshot = createEmptyUsageSnapshot(settings);
    emitUsage();
    emitStatus();
    appendLog("info", `Task started on ${new URL(tab.url).hostname} as tab-1.`);

    let previousResult: string | undefined;
    const completedInputActions = new Set<string>();
    for (let step = 1; step <= settings.maxSteps; step += 1) {
      if (isStopped(taskId)) {
        break;
      }

      const session = runningSession;
      if (!session || session.taskId !== taskId) {
        break;
      }

      await refreshTrackedTabs(session);
      const observation = await observePage(session.activeTabId);
      updateTrackedTabFromObservation(session, session.activeTabId, observation);
      appendLog("info", `Observed ${session.activeTabAlias}: ${observation.title || observation.url}`);
      const stagedFile = await loadStagedUploadFile();
      const recentDownloads = await getRecentDownloadsForPrompt(MAX_DOWNLOADS_FOR_PROMPT);

      const messages = buildAgentMessages({
        task,
        observation,
        step,
        maxSteps: settings.maxSteps,
        previousResult,
        tabs: getPromptTabs(session),
        activeTabAlias: session.activeTabAlias,
        stagedFile: stagedFile ? toPromptStagedFile(stagedFile) : undefined,
        downloads: recentDownloads
      });
      logPromptBeforeModelCall(step, messages);

      let modelResponse: AgentModelResponse;
      try {
        const modelResult = await requestAgentStep(settings, messages);
        recordUsageEvent(modelResult.usage, settings);
        modelResponse = modelResult.response;
      } catch (error) {
        if (error instanceof ModelClientError && error.usage) {
          recordUsageEvent(error.usage, settings);
        }
        if (error instanceof ModelClientError && /JSON|schema/i.test(error.message)) {
          previousResult = buildModelErrorProgress(previousResult, error.message);
          appendLog("warning", `${error.message} Asking the model to continue with valid action JSON.`);
          await sleep(450);
          continue;
        }
        throw error;
      }

      const plannedActions = getPlannedActions(modelResponse);

      appendLog("info", `${modelResponse.thought_summary} Next: ${formatActions(plannedActions)}.`);

      // Safety checks removed — all actions proceed unconditionally.

      const loopResult = await handlePlannedActions(modelResponse, plannedActions, completedInputActions, taskId);
      previousResult = buildPreviousResultForModel(loopResult);
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
  completedActions: string[];
  failedAction?: string;
  lastObservation?: PageObservation;
}

async function handlePlannedActions(
  modelResponse: AgentModelResponse,
  actions: AgentAction[],
  completedInputActions: Set<string>,
  taskId: string
): Promise<ActionLoopResult> {
  const messages: string[] = [];
  const completedActions: string[] = [];
  let lastObservation: PageObservation | undefined;

  for (let index = 0; index < actions.length; index += 1) {
    if (isStopped(taskId)) {
      return {
        ok: true,
        message: messages.join(" ") || "Stopped by user.",
        shouldStop: true,
        completedActions,
        lastObservation
      };
    }

    const action = actions[index];
    const session = runningSession;
    if (!session || session.taskId !== taskId) {
      return {
        ok: true,
        message: messages.join(" ") || "Stopped by user.",
        shouldStop: true,
        completedActions,
        lastObservation
      };
    }

    const duplicateInputAction = getDuplicateInputAction(action, completedInputActions, session.activeTabAlias);
    if (duplicateInputAction) {
      const duplicateResult = await handleDuplicateInputAction(session.activeTabId, action, duplicateInputAction);
      messages.push(formatActionResult(index, actions.length, duplicateResult.message));
      if (duplicateResult.ok && !duplicateResult.recoverable) {
        completedActions.push(formatCompletedAction(index, action, duplicateResult.message, "skipped"));
      }
      if (!duplicateResult.ok || duplicateResult.recoverable) {
        return {
          ok: duplicateResult.ok,
          recoverable: duplicateResult.recoverable,
          message: messages.join(" "),
          shouldStop: false,
          completedActions,
          failedAction: formatActionFailure(index, action, duplicateResult.message),
          lastObservation
        };
      }
      await sleep(160);
      continue;
    }

    const result = await handleSingleAction(taskId, modelResponse, action);
    messages.push(formatActionResult(index, actions.length, result.message));
    if (result.lastObservation) {
      lastObservation = result.lastObservation;
    }

    if (result.ok) {
      const latestSession = runningSession;
      rememberCompletedInputAction(action, completedInputActions, latestSession?.activeTabAlias || session.activeTabAlias);
      completedActions.push(formatCompletedAction(index, action, result.message, "done"));
    }

    if (result.shouldStop || !result.ok) {
      if (result.recoverable && index < actions.length - 1) {
        messages.push("Skipped the remaining batch actions and will re-observe the page.");
      }
      return {
        ...result,
        message: messages.join(" "),
        completedActions,
        failedAction: result.ok ? undefined : formatActionFailure(index, action, result.message),
        lastObservation
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
    shouldStop: false,
    completedActions,
    lastObservation
  };
}

async function handleSingleAction(
  taskId: string,
  modelResponse: AgentModelResponse,
  action: AgentAction
): Promise<ActionLoopResult> {
  if (action.type === "done") {
    return {
      ok: true,
      message: action.text || modelResponse.thought_summary || "Done.",
      shouldStop: true,
      completedActions: []
    };
  }

  if (action.type === "ask_user") {
    return {
      ok: true,
      message: action.text || modelResponse.thought_summary || "The agent needs input from you.",
      shouldStop: true,
      completedActions: []
    };
  }

  const session = runningSession;
  if (!session || session.taskId !== taskId) {
    return {
      ok: true,
      message: "Stopped by user.",
      shouldStop: true,
      completedActions: []
    };
  }

  if (action.type === "list_downloads") {
    const result = await listDownloads(action.maxItems);
    return {
      ok: result.ok,
      message: result.message,
      shouldStop: false,
      recoverable: result.recoverable,
      completedActions: []
    };
  }

  if (action.type === "summarize_page") {
    const result = await summarizeCurrentPage(session, action.text);
    return {
      ok: result.ok,
      message: result.message,
      shouldStop: result.ok,
      recoverable: result.recoverable,
      completedActions: [],
      lastObservation: result.observation
    };
  }

  if (action.type === "summarize_pdf") {
    const result = await summarizePdf(session, action);
    return {
      ok: result.ok,
      message: result.message,
      shouldStop: result.ok,
      recoverable: result.recoverable,
      completedActions: [],
      lastObservation: result.observation
    };
  }

  if (isTabManagementAction(action)) {
    const result = await handleTabManagementAction(session, action);
    return {
      ok: result.ok,
      message: result.message,
      shouldStop: false,
      recoverable: result.recoverable,
      completedActions: [],
      lastObservation: result.observation
    };
  }

  if (action.type === "go_back") {
    const result = await goBackInTab(session.activeTabId);
    return {
      ok: result.ok,
      message: result.message,
      shouldStop: false,
      recoverable: result.recoverable,
      completedActions: [],
      lastObservation: result.observation
    };
  }

  const result = await executeAction(session.activeTabId, action);
  return {
    ok: result.ok,
    message: result.message,
    shouldStop: false,
    recoverable: result.recoverable,
    completedActions: [],
    lastObservation: result.observation
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

function createRunningSession(taskId: string, tab: chrome.tabs.Tab): RunningSession {
  if (typeof tab.id !== "number") {
    throw new Error("The active tab does not have an id.");
  }

  const initialTab: AgentTabState = {
    alias: "tab-1",
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title,
    url: tab.url,
    active: true,
    createdAt: Date.now()
  };

  return {
    taskId,
    activeTabId: tab.id,
    activeTabAlias: initialTab.alias,
    tabs: [initialTab],
    nextTabNumber: 2,
    stopped: false
  };
}

async function refreshTrackedTabs(session: RunningSession): Promise<void> {
  const refreshedTabs: AgentTabState[] = [];
  for (const trackedTab of session.tabs) {
    const tab = await getTabSafely(trackedTab.tabId);
    if (!tab?.id) {
      continue;
    }

    refreshedTabs.push({
      ...trackedTab,
      tabId: tab.id,
      windowId: tab.windowId,
      title: tab.title,
      url: tab.url,
      active: tab.id === session.activeTabId
    });
  }

  session.tabs = refreshedTabs;
  if (!session.tabs.some((tab) => tab.tabId === session.activeTabId)) {
    const fallback = session.tabs[0];
    if (fallback) {
      setActiveTrackedTab(session, fallback);
    }
  }
}

function updateTrackedTabFromObservation(session: RunningSession, tabId: number, observation: PageObservation): void {
  session.tabs = session.tabs.map((tab) =>
    tab.tabId === tabId
      ? {
          ...tab,
          title: observation.title || tab.title,
          url: observation.url || tab.url,
          active: true,
          lastObservedAt: Date.now()
        }
      : { ...tab, active: false }
  );
}

function getPromptTabs(session: RunningSession): PromptTabInfo[] {
  return session.tabs.map((tab) => ({
    alias: tab.alias,
    title: tab.title,
    url: tab.url,
    active: tab.tabId === session.activeTabId || tab.alias === session.activeTabAlias
  }));
}

function setActiveTrackedTab(session: RunningSession, tab: AgentTabState): void {
  session.activeTabId = tab.tabId;
  session.activeTabAlias = tab.alias;
  session.tabs = session.tabs.map((trackedTab) => ({
    ...trackedTab,
    active: trackedTab.tabId === tab.tabId
  }));
}

function findTrackedTab(session: RunningSession, tabAlias?: string): AgentTabState | undefined {
  if (!tabAlias?.trim()) {
    return session.tabs.find((tab) => tab.tabId === session.activeTabId);
  }

  const normalizedAlias = tabAlias.trim().toLowerCase();
  return session.tabs.find((tab) => tab.alias.toLowerCase() === normalizedAlias);
}

function isTabManagementAction(action: AgentAction): boolean {
  return action.type === "open_tab" || action.type === "switch_tab" || action.type === "close_tab" || action.type === "reload" || action.type === "go_forward";
}

async function handleTabManagementAction(session: RunningSession, action: AgentAction): Promise<ContentActionResult> {
  if (action.type === "open_tab") {
    return openTrackedTab(session, action.url);
  }

  if (action.type === "switch_tab") {
    return switchTrackedTab(session, action.tabAlias);
  }

  if (action.type === "close_tab") {
    return closeTrackedTab(session, action.tabAlias);
  }

  if (action.type === "reload") {
    return reloadTrackedTab(session, action.tabAlias);
  }

  if (action.type === "go_forward") {
    return goForwardInTrackedTab(session);
  }

  return {
    ok: false,
    message: `Unsupported tab action: ${action.type}`
  };
}

async function openTrackedTab(session: RunningSession, url?: string): Promise<ContentActionResult> {
  if (!url) {
    return {
      ok: false,
      recoverable: true,
      message: "open_tab requires a url."
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      ok: false,
      recoverable: true,
      message: "open_tab URL is invalid."
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      recoverable: true,
      message: "open_tab only supports http(s) URLs."
    };
  }

  const activeTab = findTrackedTab(session);
  const tab = await chrome.tabs.create({
    url: parsed.toString(),
    active: true,
    windowId: activeTab?.windowId
  });

  if (typeof tab.id !== "number") {
    return {
      ok: false,
      recoverable: true,
      message: "Opened a tab, but Chrome did not return a tab id."
    };
  }

  const alias = `tab-${session.nextTabNumber}`;
  session.nextTabNumber += 1;
  const trackedTab: AgentTabState = {
    alias,
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title,
    url: tab.url || parsed.toString(),
    active: true,
    createdAt: Date.now()
  };
  session.tabs = [...session.tabs.map((existingTab) => ({ ...existingTab, active: false })), trackedTab];
  setActiveTrackedTab(session, trackedTab);
  await waitForTabToSettle(tab.id);

  return {
    ok: true,
    message: `Opened ${alias}: ${parsed.toString()}.`,
    observation: await observePageSafely(tab.id)
  };
}

async function switchTrackedTab(session: RunningSession, tabAlias?: string): Promise<ContentActionResult> {
  const trackedTab = findTrackedTab(session, tabAlias);
  if (!trackedTab) {
    return {
      ok: false,
      recoverable: true,
      message: `Could not find tracked tab alias "${tabAlias || ""}". Use one of: ${session.tabs.map((tab) => tab.alias).join(", ")}.`
    };
  }

  await chrome.tabs.update(trackedTab.tabId, { active: true });
  if (typeof trackedTab.windowId === "number") {
    await chrome.windows.update(trackedTab.windowId, { focused: true });
  }
  setActiveTrackedTab(session, trackedTab);
  await waitForTabToSettle(trackedTab.tabId);

  return {
    ok: true,
    message: `Switched to ${trackedTab.alias}.`,
    observation: await observePageSafely(trackedTab.tabId)
  };
}

async function closeTrackedTab(session: RunningSession, tabAlias?: string): Promise<ContentActionResult> {
  const trackedTab = findTrackedTab(session, tabAlias);
  if (!trackedTab) {
    return {
      ok: false,
      recoverable: true,
      message: `Could not find tracked tab alias "${tabAlias || ""}". Use one of: ${session.tabs.map((tab) => tab.alias).join(", ")}.`
    };
  }

  const remainingTabs = session.tabs.filter((tab) => tab.tabId !== trackedTab.tabId);
  if (remainingTabs.length === 0) {
    return {
      ok: false,
      recoverable: true,
      message: "Refusing to close the only tracked tab. Open or switch to another tracked tab first."
    };
  }

  const fallbackTab = remainingTabs.find((tab) => tab.tabId === session.activeTabId) || remainingTabs[0];
  session.tabs = remainingTabs;
  setActiveTrackedTab(session, fallbackTab);
  await chrome.tabs.remove(trackedTab.tabId);
  await chrome.tabs.update(fallbackTab.tabId, { active: true });
  if (typeof fallbackTab.windowId === "number") {
    await chrome.windows.update(fallbackTab.windowId, { focused: true });
  }

  return {
    ok: true,
    message: `Closed ${trackedTab.alias}. Active tab is now ${fallbackTab.alias}.`,
    observation: await observePageSafely(fallbackTab.tabId)
  };
}

async function reloadTrackedTab(session: RunningSession, tabAlias?: string): Promise<ContentActionResult> {
  const trackedTab = findTrackedTab(session, tabAlias);
  if (!trackedTab) {
    return {
      ok: false,
      recoverable: true,
      message: `Could not find tracked tab alias "${tabAlias || ""}". Use one of: ${session.tabs.map((tab) => tab.alias).join(", ")}.`
    };
  }

  await chrome.tabs.reload(trackedTab.tabId);
  await waitForTabToSettle(trackedTab.tabId);
  if (trackedTab.tabId !== session.activeTabId) {
    await switchTrackedTab(session, trackedTab.alias);
  }

  return {
    ok: true,
    message: `Reloaded ${trackedTab.alias}.`,
    observation: await observePageSafely(trackedTab.tabId)
  };
}

async function goForwardInTrackedTab(session: RunningSession): Promise<ContentActionResult> {
  const trackedTab = findTrackedTab(session);
  if (!trackedTab) {
    return {
      ok: false,
      recoverable: true,
      message: "No active tracked tab is available for go_forward."
    };
  }

  const before = await getTabSafely(trackedTab.tabId);
  try {
    await chrome.tabs.goForward(trackedTab.tabId);
  } catch (error) {
    return {
      ok: false,
      recoverable: true,
      message: `Could not go forward. This tab may not have a forward history entry. ${getErrorMessage(error)}`
    };
  }

  await waitForTabToSettle(trackedTab.tabId, before?.url);
  return {
    ok: true,
    message: `Went forward in ${trackedTab.alias}.`,
    observation: await observePageSafely(trackedTab.tabId)
  };
}

async function executeAction(tabId: number, action: AgentAction): Promise<ContentActionResult> {
  try {
    return await sendTabMessage<ContentActionResult>(tabId, { type: "CONTENT_EXECUTE", action });
  } catch (error) {
    if (shouldRecoverFromClosedMessageChannel(action, error)) {
      await waitForTabToSettle(tabId);
      const observation = await observePageSafely(tabId);
      return {
        ok: false,
        recoverable: true,
        observation,
        message: `${formatAction(action)} likely changed the page before the content script could reply. The tab was re-observed; continue from the current page and do not repeat that action unless it is still visibly needed.`
      };
    }

    throw new Error(`Could not execute ${action.type}: ${getErrorMessage(error)}`);
  }
}

async function goBackInTab(tabId: number): Promise<ContentActionResult> {
  const before = await getTabSafely(tabId);

  try {
    await chrome.tabs.goBack(tabId);
  } catch (error) {
    return {
      ok: false,
      recoverable: true,
      message: `Could not go back. This tab may not have a previous history entry. ${getErrorMessage(error)}`
    };
  }

  await waitForTabToSettle(tabId, before?.url);
  return {
    ok: true,
    message: "Went back to the previous page.",
    observation: await observePageSafely(tabId)
  };
}

async function summarizeCurrentPage(session: RunningSession, instruction?: string): Promise<ContentActionResult> {
  const observation = await observePage(session.activeTabId);
  const pageText = truncateForSummary(observation.text);
  if (!pageText.trim()) {
    return {
      ok: false,
      recoverable: true,
      observation,
      message: "No readable page text was available to summarize."
    };
  }

  const summary = await summarizeTextWithModel({
    title: observation.title || observation.url,
    sourceLabel: observation.url,
    text: pageText,
    instruction: instruction || "Summarize this web page clearly and concisely."
  });

  return {
    ok: true,
    observation,
    message: `Page summary:\n${summary}`
  };
}

async function summarizePdf(session: RunningSession, action: AgentAction): Promise<ContentActionResult> {
  const source = await resolvePdfSource(session, action);
  if (!source.ok) {
    return {
      ok: false,
      recoverable: true,
      message: source.message
    };
  }

  const extraction = await extractPdfText(source.bytes);
  if (!extraction.text.trim()) {
    return {
      ok: false,
      recoverable: true,
      message: `Could not extract readable text from ${source.label}.`
    };
  }

  const sourceDetails = [
    source.label,
    extraction.pageCount ? `${extraction.pageCount} pages` : "",
    extraction.extractedPages ? `${extraction.extractedPages} pages read` : "",
    extraction.engine === "fallback" ? "fallback extractor" : ""
  ].filter(Boolean).join(", ");

  const summary = await summarizeTextWithModel({
    title: source.label,
    sourceLabel: sourceDetails,
    text: truncateForSummary(extraction.text),
    instruction: action.text || "Summarize this PDF. Include key points, important facts, and any action items."
  });

  return {
    ok: true,
    message: `PDF summary (${sourceDetails}):\n${summary}`
  };
}

async function summarizeTextWithModel(args: {
  title: string;
  sourceLabel: string;
  text: string;
  instruction: string;
}): Promise<string> {
  const settings = await loadSettings();
  const messages: Array<{ role: "system" | "user"; content: string }> = [
    {
      role: "system",
      content: [
        "You summarize web pages and PDFs for a browser extension.",
        "Return strict JSON only.",
        "Use this schema: {\"thought_summary\":\"summary ready\",\"risk_level\":\"low\",\"action\":{\"type\":\"done\",\"text\":\"the user-facing summary\"}}.",
        "Keep the summary useful, structured, and faithful to the supplied text. If the text is sparse, say what is missing."
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `Instruction: ${args.instruction}`,
        `Title: ${args.title}`,
        `Source: ${args.sourceLabel}`,
        "",
        "Text to summarize:",
        args.text
      ].join("\n")
    }
  ];

  const result = await requestAgentStep(settings, messages);
  recordUsageEvent(result.usage, settings);
  const doneAction = result.response.actions?.find((action) => action.type === "done");
  return doneAction?.text || result.response.thought_summary || "The model did not return a summary.";
}

async function resolvePdfSource(
  session: RunningSession,
  action: AgentAction
): Promise<{ ok: true; bytes: Uint8Array; label: string } | { ok: false; message: string }> {
  if (action.fileId) {
    const stagedFile = await loadStagedUploadFile();
    if (!stagedFile || stagedFile.id !== action.fileId) {
      return { ok: false, message: `Staged PDF file ${action.fileId} is not available.` };
    }
    return {
      ok: true,
      bytes: dataUrlToUint8Array(stagedFile.dataUrl),
      label: `${stagedFile.name} (${formatFileSize(stagedFile.size)})`
    };
  }

  if (action.downloadId) {
    const download = await getDownloadById(action.downloadId);
    const url = download?.finalUrl || download?.url;
    if (!url) {
      return { ok: false, message: `Download ${action.downloadId} does not have a source URL that can be fetched.` };
    }
    return fetchPdfBytes(url, download.filename || url);
  }

  if (action.url) {
    return fetchPdfBytes(action.url, action.url);
  }

  const activeTab = await getTabSafely(session.activeTabId);
  if (activeTab?.url && isLikelyPdfUrl(activeTab.url)) {
    return fetchPdfBytes(activeTab.url, activeTab.title || activeTab.url);
  }

  const stagedFile = await loadStagedUploadFile();
  if (stagedFile && isLikelyPdfFile(stagedFile)) {
    return {
      ok: true,
      bytes: dataUrlToUint8Array(stagedFile.dataUrl),
      label: `${stagedFile.name} (${formatFileSize(stagedFile.size)})`
    };
  }

  const latestPdfDownload = (await getRecentDownloads(10)).find((download) => isDownloadLikelyPdf(download));
  const downloadUrl = latestPdfDownload?.finalUrl || latestPdfDownload?.url;
  if (downloadUrl) {
    return fetchPdfBytes(downloadUrl, latestPdfDownload.filename || downloadUrl);
  }

  return {
    ok: false,
    message: "No PDF source was found. Provide a PDF url, downloadId, or stage a PDF file in the side panel."
  };
}

async function fetchPdfBytes(url: string, label: string): Promise<{ ok: true; bytes: Uint8Array; label: string } | { ok: false; message: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, message: "PDF URL is invalid." };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, message: "PDF summarization can fetch http(s) URLs or use a staged local PDF." };
  }

  try {
    const response = await fetch(parsed.toString(), { credentials: "include" });
    if (!response.ok) {
      return { ok: false, message: `Could not fetch PDF (${response.status}) from ${parsed.toString()}.` };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { ok: true, bytes, label };
  } catch (error) {
    return { ok: false, message: `Could not fetch PDF from ${parsed.toString()}. ${getErrorMessage(error)}` };
  }
}

async function listDownloads(maxItems?: number): Promise<{ ok: boolean; message: string; recoverable?: boolean }> {
  const downloads = await getRecentDownloads(Math.min(Math.max(Number(maxItems || 8), 1), 20));
  if (downloads.length === 0) {
    return {
      ok: true,
      message: "No recent downloads were found."
    };
  }

  return {
    ok: true,
    message: `Recent downloads:\n${downloads.map(formatDownloadForLog).join("\n")}`
  };
}

async function logCompletedDownload(downloadId: number): Promise<void> {
  const download = await getDownloadById(downloadId);
  if (!download) {
    return;
  }

  appendLog("success", `Download complete: ${formatDownloadForLog(download)}`);
}

async function getDownloadById(downloadId: number): Promise<chrome.downloads.DownloadItem | undefined> {
  const downloads = await chrome.downloads.search({ id: downloadId });
  return downloads[0];
}

async function getRecentDownloads(limit: number): Promise<chrome.downloads.DownloadItem[]> {
  if (!chrome.downloads?.search) {
    return [];
  }

  return chrome.downloads.search({
    limit,
    orderBy: ["-startTime"]
  });
}

async function getRecentDownloadsForPrompt(limit: number): Promise<Array<{
  id: number;
  filename?: string;
  url?: string;
  mime?: string;
  state?: string;
  totalBytes?: number;
  exists?: boolean;
}> > {
  return (await getRecentDownloads(limit)).map((download) => ({
    id: download.id,
    filename: download.filename,
    url: download.finalUrl || download.url,
    mime: download.mime,
    state: download.state,
    totalBytes: download.totalBytes,
    exists: download.exists
  }));
}

function formatDownloadForLog(download: chrome.downloads.DownloadItem): string {
  const filename = download.filename ? download.filename.split(/[\\/]/).pop() || download.filename : "download";
  const size = download.totalBytes && download.totalBytes > 0 ? ` ${formatFileSize(download.totalBytes)}` : "";
  const mime = download.mime ? ` ${download.mime}` : "";
  const url = download.finalUrl || download.url || "";
  return `#${download.id} ${filename}${size}${mime}${url ? ` <${url}>` : ""}`;
}

function toPromptStagedFile(file: StagedUploadFile): {
  id: string;
  name: string;
  type: string;
  size: number;
} {
  return {
    id: file.id,
    name: file.name,
    type: file.type,
    size: file.size
  };
}

function isLikelyPdfFile(file: StagedUploadFile): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

function isDownloadLikelyPdf(download: chrome.downloads.DownloadItem): boolean {
  return download.mime === "application/pdf" || isLikelyPdfUrl(download.filename) || isLikelyPdfUrl(download.finalUrl || download.url);
}

function isLikelyPdfUrl(url?: string): boolean {
  return Boolean(url && (/\.pdf(?:[?#].*)?$/i.test(url) || /application\/pdf/i.test(url)));
}

function truncateForSummary(text: string): string {
  return text.length <= MAX_SUMMARY_INPUT_CHARS ? text : `${text.slice(0, MAX_SUMMARY_INPUT_CHARS - 32)}\n[truncated for summary]`;
}

async function observePageSafely(tabId: number): Promise<PageObservation | undefined> {
  try {
    return await observePage(tabId);
  } catch (error) {
    console.warn("[BYOK Agent] Could not observe page after browser navigation.", error);
    return undefined;
  }
}

async function getTabSafely(tabId: number): Promise<chrome.tabs.Tab | undefined> {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return undefined;
  }
}

async function waitForTabToSettle(tabId: number, previousUrl?: string): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < TAB_SETTLE_TIMEOUT_MS) {
    const tab = await getTabSafely(tabId);
    if (!tab) {
      return;
    }

    const urlChanged = previousUrl && tab.url && tab.url !== previousUrl;
    if (tab.status === "complete" && (!previousUrl || urlChanged || Date.now() - startedAt > 700)) {
      await sleep(250);
      return;
    }

    await sleep(120);
  }
}

function shouldRecoverFromClosedMessageChannel(action: AgentAction, error: unknown): boolean {
  if (!canActionUnloadContentScript(action)) {
    return false;
  }

  const message = getErrorMessage(error);
  return /message channel closed|asynchronous response|receiving end does not exist|extension context invalidated|context invalidated/i.test(
    message
  );
}

function canActionUnloadContentScript(action: AgentAction): boolean {
  return action.type === "click" || action.type === "multi_click" || action.type === "navigate" || action.type === "go_back";
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

function emitUsage(): void {
  notifySidePanel({
    type: "USAGE_UPDATE",
    usage: usageSnapshot
  } satisfies BackgroundToSidePanelMessage);
}

function createEmptyUsageSnapshot(settings?: { provider: AgentUsageSnapshot["provider"]; model: string }): AgentUsageSnapshot {
  return {
    requestCount: 0,
    successfulRequestCount: 0,
    cacheHitRequestCount: 0,
    promptTokens: 0,
    cachedPromptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    totalLatencyMs: 0,
    costConfigured: false,
    provider: settings?.provider,
    model: settings?.model
  };
}

function recordUsageEvent(event: ModelUsageEvent, settings: {
  inputTokenCostPerMillion?: number;
  cachedInputTokenCostPerMillion?: number;
  outputTokenCostPerMillion?: number;
}): void {
  const promptTokens = event.promptTokens || 0;
  const cachedPromptTokens = event.cachedPromptTokens || 0;
  const completionTokens = event.completionTokens || 0;
  const totalTokens = event.totalTokens || promptTokens + completionTokens;
  const requestCount = usageSnapshot.requestCount + 1;
  const totalLatencyMs = usageSnapshot.totalLatencyMs + event.elapsedMs;
  const estimatedEventCost = estimateUsageCost(event, settings);
  const costConfigured = usageSnapshot.costConfigured || typeof estimatedEventCost === "number";

  usageSnapshot = {
    requestCount,
    successfulRequestCount: usageSnapshot.successfulRequestCount + (event.ok ? 1 : 0),
    cacheHitRequestCount: usageSnapshot.cacheHitRequestCount + (cachedPromptTokens > 0 ? 1 : 0),
    promptTokens: usageSnapshot.promptTokens + promptTokens,
    cachedPromptTokens: usageSnapshot.cachedPromptTokens + cachedPromptTokens,
    completionTokens: usageSnapshot.completionTokens + completionTokens,
    totalTokens: usageSnapshot.totalTokens + totalTokens,
    totalLatencyMs,
    averageLatencyMs: Math.round(totalLatencyMs / requestCount),
    lastLatencyMs: event.elapsedMs,
    lastStatus: event.status,
    estimatedCostUsd:
      typeof estimatedEventCost === "number"
        ? (usageSnapshot.estimatedCostUsd || 0) + estimatedEventCost
        : usageSnapshot.estimatedCostUsd,
    costConfigured,
    provider: event.provider,
    model: event.model,
    updatedAt: event.timestamp
  };

  console.info("[BYOK Agent] Usage dashboard update:", usageSnapshot);
  emitUsage();
}

function estimateUsageCost(
  event: ModelUsageEvent,
  settings: {
    inputTokenCostPerMillion?: number;
    cachedInputTokenCostPerMillion?: number;
    outputTokenCostPerMillion?: number;
  }
): number | undefined {
  const hasInputRate = typeof settings.inputTokenCostPerMillion === "number";
  const hasCachedRate = typeof settings.cachedInputTokenCostPerMillion === "number";
  const hasOutputRate = typeof settings.outputTokenCostPerMillion === "number";
  if (!hasInputRate && !hasCachedRate && !hasOutputRate) {
    return undefined;
  }

  const promptTokens = event.promptTokens || 0;
  const cachedPromptTokens = Math.min(event.cachedPromptTokens || 0, promptTokens);
  const uncachedPromptTokens = Math.max(0, promptTokens - cachedPromptTokens);
  const inputRate = settings.inputTokenCostPerMillion || 0;
  const cachedInputRate = hasCachedRate ? settings.cachedInputTokenCostPerMillion || 0 : inputRate;
  const outputRate = settings.outputTokenCostPerMillion || 0;

  return (
    uncachedPromptTokens * inputRate +
    cachedPromptTokens * cachedInputRate +
    (event.completionTokens || 0) * outputRate
  ) / 1_000_000;
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

  const visibleActions = actions.slice(0, MAX_ACTION_LOG_PREVIEW).map(formatAction).join(" -> ");
  const suffix = actions.length > MAX_ACTION_LOG_PREVIEW ? ` -> ... (${actions.length - MAX_ACTION_LOG_PREVIEW} more)` : "";
  return `${actions.length} actions: ${visibleActions}${suffix}`;
}

function formatAction(action: AgentAction): string {
  if (action.type === "multi_click") {
    return `select ${action.elementIds?.length || 0} options`;
  }
  if (action.type === "multi_drag") {
    return `drag ${action.dragPairs?.length || 0} pairs`;
  }
  if (action.type === "upload_file") {
    return `upload file to ${action.elementId || "file input"}`;
  }
  if (action.type === "summarize_page") {
    return "summarize page";
  }
  if (action.type === "summarize_pdf") {
    return action.downloadId ? `summarize PDF download #${action.downloadId}` : `summarize PDF ${action.url || action.fileId || ""}`.trim();
  }
  if (action.type === "list_downloads") {
    return "list downloads";
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
  if (action.type === "go_back") {
    return "go back";
  }
  if (action.type === "go_forward") {
    return "go forward";
  }
  if (action.type === "reload") {
    return `reload ${action.tabAlias || "active tab"}`;
  }
  if (action.type === "open_tab") {
    return `open tab ${action.url || "URL"}`;
  }
  if (action.type === "switch_tab") {
    return `switch to ${action.tabAlias || "tab"}`;
  }
  if (action.type === "close_tab") {
    return `close ${action.tabAlias || "active tab"}`;
  }
  if (action.type === "scroll") {
    return `scroll ${action.direction || "down"}`;
  }
  return action.type;
}

function formatActionResult(index: number, total: number, message: string): string {
  return total > 1 ? `[${index + 1}/${total}] ${message}` : message;
}

function formatCompletedAction(index: number, action: AgentAction, message: string, status: "done" | "skipped"): string {
  return `${index + 1}. ${status}: ${formatAction(action)} -> ${message}`;
}

function formatActionFailure(index: number, action: AgentAction, message: string): string {
  return `${index + 1}. failed: ${formatAction(action)} -> ${message}`;
}

function buildPreviousResultForModel(result: ActionLoopResult): string {
  const parts = [
    `Last browser execution result: ${result.message}`,
    formatCompletedActionsForModel(result.completedActions),
    result.failedAction ? `Action needing correction: ${result.failedAction}` : "",
    result.recoverable
      ? "Recovery note: the page was re-observed after the issue. Continue from the current observation, do not retry stale or non-editable element IDs, use the focused or empty fillable control when available, and do not repeat completed actions."
      : "",
    result.lastObservation ? formatObservationProgress(result.lastObservation) : ""
  ].filter(Boolean);

  return parts.join("\n");
}

function buildModelErrorProgress(previousResult: string | undefined, errorMessage: string): string {
  return [
    previousResult ? `Progress before invalid model JSON:\n${previousResult}` : "",
    `The last AI response could not be used: ${errorMessage}`,
    "Return valid strict JSON using action or actions, and continue from the current page observation without repeating completed actions."
  ]
    .filter(Boolean)
    .join("\n");
}

function formatCompletedActionsForModel(completedActions: string[]): string {
  if (completedActions.length === 0) {
    return "";
  }

  const hiddenCount = Math.max(0, completedActions.length - MAX_PROGRESS_LINES_FOR_PROMPT);
  const visibleActions = completedActions.slice(-MAX_PROGRESS_LINES_FOR_PROMPT);
  const prefix = hiddenCount ? `Completed actions before this AI call (${hiddenCount} earlier omitted, latest shown):` : "Completed actions before this AI call:";
  return [prefix, ...visibleActions.map((action) => `- ${action}`)].join("\n");
}

function formatObservationProgress(observation: PageObservation): string {
  const focusedElement = observation.elements.find((element) => element.isFocused);
  const filledElements = observation.elements
    .filter(hasCompletedControlValue)
    .slice(0, 8)
    .map(
      (element) =>
        `${element.id}${element.questionNumber ? ` problem=${element.questionNumber}` : ""} ${
          element.value ? `value=${element.value}` : `checkedState=${element.checkedState}`
        }`
    );

  return [
    `Latest page after browser execution: ${observation.title || observation.url}`,
    observation.viewport
      ? `Viewport after execution: scrollY=${observation.viewport.scrollY}, pageProgress=${observation.viewport.progressPercent}%`
      : "",
    focusedElement ? `Focused element after execution: ${focusedElement.id} ${focusedElement.label || focusedElement.text || focusedElement.tag}` : "",
    filledElements.length ? `Visible filled fields after execution: ${filledElements.join(" | ")}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function hasCompletedControlValue(element: PageObservation["elements"][number]): boolean {
  if (element.checkedState) {
    return element.checkedState === "checked" || element.checkedState === "mixed";
  }

  return Boolean(element.value && !/\bunchecked\)?$/i.test(element.value.trim()));
}

function getPostBatchDelay(actions: AgentAction[]): number {
  return actions.some(isNavigationLikeAction) ? 1500 : 450;
}

function getInterActionDelay(action: AgentAction): number {
  if (isNavigationLikeAction(action)) {
    return 1200;
  }
  if (action.type === "drag" || action.type === "multi_drag") {
    return 300;
  }
  return 180;
}

function shouldHaltBatchAfterAction(action: AgentAction): boolean {
  return isNavigationLikeAction(action);
}

function isNavigationLikeAction(action: AgentAction): boolean {
  return (
    action.type === "navigate" ||
    action.type === "go_back" ||
    action.type === "go_forward" ||
    action.type === "reload" ||
    action.type === "open_tab" ||
    action.type === "switch_tab" ||
    action.type === "close_tab"
  );
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

function getDuplicateInputAction(action: AgentAction, completedInputActions: Set<string>, tabAlias: string): DuplicateInputAction | undefined {
  const key = getInputActionKey(action, tabAlias);
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

  if (action.type === "upload_file") {
    return {
      message: `Skipped repeated upload_file on ${action.elementId}; that file input was already handled.`,
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

function rememberCompletedInputAction(action: AgentAction, completedInputActions: Set<string>, tabAlias: string): void {
  const key = getInputActionKey(action, tabAlias);
  if (key) {
    completedInputActions.add(key);
  }
}

function getInputActionKey(action: AgentAction, tabAlias: string): string | undefined {
  const prefix = `${tabAlias}:`;
  if (action.type === "multi_click") {
    return action.elementIds?.length ? `${prefix}multi_click:${[...action.elementIds].sort().join(",")}` : undefined;
  }

  if (action.type === "multi_drag") {
    return action.dragPairs?.length
      ? `${prefix}multi_drag:${action.dragPairs.map((pair) => `${pair.elementId}->${pair.targetElementId}`).join("|")}`
      : undefined;
  }

  if (action.type === "drag") {
    return action.elementId && action.targetElementId ? `${prefix}drag:${action.elementId}->${action.targetElementId}` : undefined;
  }

  if (action.type === "upload_file") {
    return action.elementId ? `${prefix}upload_file:${action.elementId}:${action.fileId || "staged"}` : undefined;
  }

  if ((action.type !== "fill" && action.type !== "type" && action.type !== "select") || !action.elementId) {
    return undefined;
  }

  if (action.type === "fill" || action.type === "type") {
    return `${prefix}fill:${action.elementId}`;
  }

  if (typeof action.text !== "string") {
    return undefined;
  }

  return `${prefix}select:${action.elementId}:${normalizeActionText(action.text)}`;
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
