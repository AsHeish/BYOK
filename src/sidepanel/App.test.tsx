// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import type { SidePanelToBackgroundMessage } from "../shared/types";
import { App } from "./App";

vi.mock("./modelTransport", () => ({ connectModelTransport: () => () => undefined }));

let container: HTMLDivElement;
let root: Root;
let stored: Record<string, unknown>;
let sent: SidePanelToBackgroundMessage[];
const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  stored = { byokAgentSettings: { ...DEFAULT_SETTINGS, apiKey: "old-llm-key", model: "gemma-4-31b", jev: { mode: "off", apiKey: "jev-key" } } };
  sent = [];
  const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
  vi.stubGlobal("chrome", {
    runtime: {
      onMessage: event(),
      sendMessage: vi.fn((message: SidePanelToBackgroundMessage, callback: (response: unknown) => void) => {
        sent.push(message);
        callback(message.type === "SIDEPANEL_GET_STATE" ? { running: false, logs: [], chatMessages: [] } : { ok: true });
      }),
    },
    storage: {
      onChanged: event(),
      local: {
        get: vi.fn(async (key: string) => ({ [key]: stored[key] })),
        set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(stored, value); }),
      },
    },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  vi.unstubAllGlobals();
});

function button(label: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll("button")).find((element) => element.textContent === label || element.getAttribute("aria-label") === label);
  expect(result).toBeDefined();
  return result!;
}

describe("task configuration snapshot", () => {
  it("submits unsaved Jev Only selection instead of the saved LLM provider", async () => {
    await act(async () => root.render(<App />));
    await act(async () => button("Settings").click());
    const provider = Array.from(container.querySelectorAll("select")).find((select) => Array.from(select.options).some((option) => option.value === "jev-only"))!;
    expect(provider).toBeDefined();
    await act(async () => {
      provider.value = "jev-only";
      provider.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button("Chat").click());
    expect(container.querySelector('[aria-label="Jev capabilities"]')?.textContent).toContain("No LLM is used");
    const input = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Find the installation guide");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button("Send message").disabled).toBe(false);
    await act(async () => button("Send message").click());
    const tasks = sent.filter((message) => message.type === "SIDEPANEL_SEND_CHAT");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ message: "Find the installation guide", settings: { jev: { mode: "only", apiKey: "jev-key" } } });
    expect(stored.byokAgentSettings).toMatchObject({ model: "gemma-4-31b", jev: { mode: "off" } });
  });
});