import { executeAction } from "./actions";
import { checkWaitCondition, observePage } from "./domMap";
import { readFullPageDocument } from "./pageReader";
import type { BackgroundToContentMessage, ContentActionResult } from "../shared/types";

declare global {
  interface Window {
    __BYOK_AGENT_CONTENT_LOADED__?: boolean;
  }
}

if (!window.__BYOK_AGENT_CONTENT_LOADED__) {
  window.__BYOK_AGENT_CONTENT_LOADED__ = true;

  chrome.runtime.onMessage.addListener((message: BackgroundToContentMessage, _sender, sendResponse) => {
    void handleMessage(message)
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          message: error instanceof Error ? error.message : String(error)
        } satisfies ContentActionResult);
      });

    return true;
  });
}

async function handleMessage(message: BackgroundToContentMessage) {
  if (message.type === "CONTENT_OBSERVE") {
    return observePage();
  }

  if (message.type === "CONTENT_EXECUTE") {
    return executeAction(message.action);
  }

  if (message.type === "CONTENT_READ_PAGE") {
    return readFullPageDocument();
  }

  if (message.type === "CONTENT_CHECK_WAIT") {
    return checkWaitCondition(message.request);
  }

  return {
    ok: false,
    message: "Unsupported content script message."
  } satisfies ContentActionResult;
}
