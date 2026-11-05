import type { JevTraceEntry, SidePanelToBackgroundMessage } from "../shared/types";

export const JEV_TRACE_FORMAT = "byok-browser-agent-jev-trace";

export function buildJevTraceExport(entries: JevTraceEntry[], exportedAt = Date.now()) {
  return { format: JEV_TRACE_FORMAT, version: 1, exportedAt: new Date(exportedAt).toISOString(), entries };
}

export function fetchJevTrace(): Promise<JevTraceEntry[]> {
  const message: SidePanelToBackgroundMessage = { type: "SIDEPANEL_GET_JEV_TRACE" };
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: unknown) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      const trace = (response as { trace?: unknown } | undefined)?.trace;
      resolve(Array.isArray(trace) ? trace as JevTraceEntry[] : []);
    });
  });
}

export function downloadJson(fileName: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
