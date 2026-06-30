import { useEffect, useMemo, useState } from "react";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { loadSettings, saveSettings } from "../shared/storage";
import type {
  AgentLogEntry,
  AgentSettings,
  AgentUsageSnapshot,
  BackgroundToSidePanelMessage,
  SidePanelToBackgroundMessage
} from "../shared/types";
import { ActionLog } from "./components/ActionLog";
import { SettingsPanel } from "./components/SettingsPanel";
import { TaskRunner } from "./components/TaskRunner";
import { UsageDashboard } from "./components/UsageDashboard";

type View = "run" | "console" | "settings";

export function App() {
  const [view, setView] = useState<View>("run");
  const [settings, setSettings] = useState<AgentSettings>(DEFAULT_SETTINGS);
  const [logs, setLogs] = useState<AgentLogEntry[]>([]);
  const [usage, setUsage] = useState<AgentUsageSnapshot>(createEmptyUsageSnapshot());
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();

  useEffect(() => {
    void loadSettings().then(setSettings);
    void sendBackgroundMessage({ type: "SIDEPANEL_GET_STATE" }).then((state) => {
      if (isAgentState(state)) {
        setRunning(state.running);
        setLogs(filterHiddenActionLogs(state.logs));
        setUsage(state.usage || createEmptyUsageSnapshot());
      }
    });

    const listener = (message: BackgroundToSidePanelMessage) => {
      if (message.type === "AGENT_LOG") {
        if (!isHiddenActionLog(message.entry.message)) {
          setLogs((current) => [...current, message.entry].slice(-80));
        }
      }
      if (message.type === "AGENT_STATUS") {
        setRunning(message.running);
      }
      if (message.type === "USAGE_UPDATE") {
        setUsage(message.usage);
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
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

  async function handleStop() {
    await sendBackgroundMessage({ type: "SIDEPANEL_STOP_TASK" });
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-line">
            <span className="brand-mark" aria-hidden="true">
              BA
            </span>
            <h1>BYOK Agent</h1>
          </div>
          <p className="status-pill">
            <span className={`status-dot ${running ? "running" : hasApiKey ? "ready" : "needs-settings"}`} />
            {running ? "Running" : hasApiKey ? "Ready" : "Needs settings"}
          </p>
        </div>
        <div className="top-actions">
          <button
            className="theme-toggle"
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            onClick={() => void handleToggleTheme()}
          >
            <span className="theme-toggle-track">
              <span className="theme-toggle-thumb" />
            </span>
            <span>{theme === "dark" ? "Dark" : "Light"}</span>
          </button>
        </div>
      </header>

      <nav className="tabs" aria-label="Side panel views">
        <button className={view === "run" ? "active" : ""} onClick={() => setView("run")}>
          Run
        </button>
        <button className={view === "console" ? "active" : ""} onClick={() => setView("console")}>
          Console
        </button>
        <button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>
          Settings
        </button>
      </nav>

      {notice ? <div className="notice">{notice}</div> : null}

      <div className={`view-scroll ${view === "run" ? "run-view" : view === "console" ? "console-view" : "settings-view"}`}>
        {view === "run" ? (
          <>
            <TaskRunner running={running} disabled={!hasApiKey} onRun={handleRun} onStop={handleStop} />
            <ActionLog logs={logs} />
          </>
        ) : view === "console" ? (
          <UsageDashboard usage={usage} />
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
