import { useEffect, useMemo, useState } from "react";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import { loadSettings, saveSettings } from "../shared/storage";
import type {
  AgentLogEntry,
  AgentSettings,
  BackgroundToSidePanelMessage,
  SidePanelToBackgroundMessage
} from "../shared/types";
import { ActionLog } from "./components/ActionLog";
import { SettingsPanel } from "./components/SettingsPanel";
import { TaskRunner } from "./components/TaskRunner";

type View = "run" | "settings";

export function App() {
  const [view, setView] = useState<View>("run");
  const [settings, setSettings] = useState<AgentSettings>(DEFAULT_SETTINGS);
  const [logs, setLogs] = useState<AgentLogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();

  useEffect(() => {
    void loadSettings().then(setSettings);
    void sendBackgroundMessage({ type: "SIDEPANEL_GET_STATE" }).then((state) => {
      if (isAgentState(state)) {
        setRunning(state.running);
        setLogs(filterLegacyApprovalLogs(state.logs));
      }
    });

    const listener = (message: BackgroundToSidePanelMessage) => {
      if (message.type === "AGENT_LOG") {
        if (!isLegacyApprovalLog(message.entry.message)) {
          setLogs((current) => [...current, message.entry].slice(-80));
        }
      }
      if (message.type === "AGENT_STATUS") {
        setRunning(message.running);
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
          <h1>BYOK Agent</h1>
          <p>
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
          <nav className="tabs" aria-label="Side panel views">
            <button className={view === "run" ? "active" : ""} onClick={() => setView("run")}>
              Run
            </button>
            <button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>
              Settings
            </button>
          </nav>
        </div>
      </header>

      {notice ? <div className="notice">{notice}</div> : null}

      <div className={`view-scroll ${view === "run" ? "run-view" : "settings-view"}`}>
        {view === "run" ? (
          <>
            <TaskRunner running={running} disabled={!hasApiKey} onRun={handleRun} onStop={handleStop} />
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
} {
  return value !== null && typeof value === "object" && "running" in value && "logs" in value;
}

function filterLegacyApprovalLogs(logs: AgentLogEntry[]): AgentLogEntry[] {
  return logs.filter((entry) => !isLegacyApprovalLog(entry.message));
}

function isLegacyApprovalLog(message: string): boolean {
  return /This page appears to be an assessment|Waiting for|model marked this action as high risk|This looks like a quiz|This looks like a payment/i.test(
    message
  );
}
