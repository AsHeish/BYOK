import { useEffect, useMemo, useState } from "react";
import {
  MessageCircle,
  History as HistoryIcon,
  MoreVertical,
  Moon,
  SlidersHorizontal,
  SquareTerminal,
  Sun
} from "lucide-react";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import {
  RUN_REPORTS_KEY,
  clearRunReports,
  deleteRunReport,
  loadRunReports,
  loadSettings,
  saveSettings,
} from "../shared/storage";
import type {
  AgentChatMessage,
  AgentLogEntry,
  AgentSettings,
  AgentUsageSnapshot,
  BackgroundToSidePanelMessage,
  RunReport,
  SidePanelToBackgroundMessage
} from "../shared/types";
import { ActionLog } from "./components/ActionLog";
import { ChatPanel } from "./components/ChatPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { UsageDashboard } from "./components/UsageDashboard";
import { RunHistory } from "./components/RunHistory";

type View = "chat" | "history" | "console" | "settings";

export function App() {
  const [view, setView] = useState<View>("chat");
  const [settings, setSettings] = useState<AgentSettings>(DEFAULT_SETTINGS);
  const [logs, setLogs] = useState<AgentLogEntry[]>([]);
  const [chatMessages, setChatMessages] = useState<AgentChatMessage[]>([]);
  const [usage, setUsage] = useState<AgentUsageSnapshot>(createEmptyUsageSnapshot());
  const [reports, setReports] = useState<RunReport[]>([]);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();

  useEffect(() => {
    void loadSettings().then(setSettings);
    void loadRunReports().then(setReports);
    void sendBackgroundMessage({ type: "SIDEPANEL_GET_STATE" }).then((state) => {
      if (isAgentState(state)) {
        setRunning(state.running);
        setLogs(filterHiddenActionLogs(state.logs));
        setChatMessages(state.chatMessages || []);
        setUsage(state.usage || createEmptyUsageSnapshot());
      }
    });

    const listener = (message: BackgroundToSidePanelMessage) => {
      if (message.type === "AGENT_LOG") {
        if (!isHiddenActionLog(message.entry.message)) {
          setLogs((current) => [...current, message.entry].slice(-80));
        }
      }
      if (message.type === "AGENT_CHAT_MESSAGE") {
        setChatMessages((current) => [...current, message.message].slice(-100));
      }
      if (message.type === "AGENT_CHAT_CLEARED") {
        setChatMessages([]);
      }
      if (message.type === "AGENT_STATUS") {
        setRunning(message.running);
      }
      if (message.type === "USAGE_UPDATE") {
        setUsage(message.usage);
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    const storageListener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName === "local" && changes[RUN_REPORTS_KEY]) {
        void loadRunReports().then(setReports);
      }
    };
    chrome.storage.onChanged.addListener(storageListener);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
      chrome.storage.onChanged.removeListener(storageListener);
    };
  }, []);

  const hasApiKey = useMemo(() => settings.apiKey.trim().length > 0, [settings.apiKey]);
  const theme = settings.theme;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  async function handleSaveSettings() {
    await saveSettings(settings);
    setNotice("Settings saved.");
    window.setTimeout(() => setNotice(undefined), 1800);
  }

  async function handleToggleTheme() {
    const nextSettings: AgentSettings = {
      ...settings,
      theme: settings.theme === "dark" ? "light" : "dark"
    };
    setSettings(nextSettings);
    await saveSettings(nextSettings);
  }

  async function handleRun(task: string) {
    setNotice(undefined);
    await sendBackgroundMessage({ type: "SIDEPANEL_RUN_TASK", task });
  }

  async function handleChat(message: string) {
    setNotice(undefined);
    await sendBackgroundMessage({ type: "SIDEPANEL_SEND_CHAT", message });
  }

  async function handleStop() {
    await sendBackgroundMessage({ type: "SIDEPANEL_STOP_TASK" });
  }

  async function handleClearChat() {
    await sendBackgroundMessage({ type: "SIDEPANEL_CLEAR_CHAT" });
    setChatMessages([]);
  }

  async function handleRerun(task: string) {
    setView("chat");
    await handleRun(task);
  }

  async function handleDeleteRun(runId: string) {
    setReports(await deleteRunReport(runId));
  }

  async function handleClearRuns() {
    await clearRunReports();
    setReports([]);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-line">
          <span className="brand-mark" aria-hidden="true">
            BA
          </span>
          <h1>BYOK Agent</h1>
          <p className="status-pill">
            <span className={`status-dot ${hasApiKey ? "ready" : "needs-settings"}`} />
            {hasApiKey ? "Ready" : "Needs settings"}
          </p>
        </div>
        <div className="top-actions">
          <button
            type="button"
            className="header-icon-button theme-toggle"
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            onClick={() => void handleToggleTheme()}
          >
            {theme === "dark" ? <Sun /> : <Moon />}
          </button>
          <button
            type="button"
            className="header-icon-button more-button"
            aria-label="Open settings"
            title="Open settings"
            onClick={() => setView("settings")}
          >
            <MoreVertical />
          </button>
        </div>
      </header>

      <nav className="tabs" aria-label="Side panel views">
        <button type="button" className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}>
          <MessageCircle aria-hidden="true" />
          <span>Chat</span>
        </button>
        <button type="button" className={view === "history" ? "active" : ""} onClick={() => setView("history")}>
          <HistoryIcon aria-hidden="true" />
          <span>History</span>
        </button>
        <button type="button" className={view === "console" ? "active" : ""} onClick={() => setView("console")}>
          <SquareTerminal aria-hidden="true" />
          <span>Console</span>
        </button>
        <button type="button" className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>
          <SlidersHorizontal aria-hidden="true" />
          <span>Settings</span>
        </button>
      </nav>

      {notice ? <div className="notice">{notice}</div> : null}

      <div className={`view-scroll ${view}-view`}>
        {view === "chat" ? (
          <ChatPanel
            messages={chatMessages}
            currentLog={logs[logs.length - 1]}
            running={running}
            disabled={!hasApiKey}
            model={settings.model}
            onSend={handleChat}
            onStop={handleStop}
            onClear={handleClearChat}
          />
        ) : view === "history" ? (
          <RunHistory
            reports={reports}
            running={running}
            onRerun={handleRerun}
            onDelete={handleDeleteRun}
            onClear={handleClearRuns}
          />
        ) : view === "console" ? (
          <>
            <UsageDashboard usage={usage} />
            <ActionLog logs={logs} />
          </>
        ) : (
          <SettingsPanel settings={settings} onChange={setSettings} onSave={handleSaveSettings} />
        )}
      </div>
    </main>
  );
}

function sendBackgroundMessage(message: SidePanelToBackgroundMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

function isAgentState(value: unknown): value is {
  running: boolean;
  logs: AgentLogEntry[];
  chatMessages?: AgentChatMessage[];
  usage?: AgentUsageSnapshot;
} {
  return value !== null && typeof value === "object" && "running" in value && "logs" in value;
}

function filterHiddenActionLogs(logs: AgentLogEntry[]): AgentLogEntry[] {
  return logs.filter((entry) => !isHiddenActionLog(entry.message));
}

function isHiddenActionLog(message: string): boolean {
  return (
    message.startsWith("Prompt sent to AI") ||
    /This page appears to be an assessment|Waiting for|model marked this action as high risk|This looks like a quiz|This looks like a payment/i.test(
      message
    )
  );
}

function createEmptyUsageSnapshot(): AgentUsageSnapshot {
  return {
    requestCount: 0,
    successfulRequestCount: 0,
    cacheHitRequestCount: 0,
    promptTokens: 0,
    cachedPromptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    totalLatencyMs: 0,
    costConfigured: false
  };
}
