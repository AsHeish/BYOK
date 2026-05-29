import type {
  BackgroundToContentMessage,
  ContentActionResult,
  PageObservation
} from "../shared/types";

export function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tabs[0]);
    });
  });
}

export function sendTabMessage<T extends PageObservation | ContentActionResult>(
  tabId: number,
  message: BackgroundToContentMessage
): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response: T | undefined) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (!response) {
        reject(new Error("The page did not return a response."));
        return;
      }
      resolve(response);
    });
  });
}

export async function tryInjectContentScript(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
}

export function notifyPopup(message: unknown): void {
  chrome.runtime.sendMessage(message, () => {
    // It is normal for this to fail when the popup is closed.
    void chrome.runtime.lastError;
  });
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
