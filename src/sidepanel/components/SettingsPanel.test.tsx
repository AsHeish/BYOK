// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../../shared/defaults";
import type { AgentSettings, AgentUsageSnapshot } from "../../shared/types";
import { SettingsPanel } from "./SettingsPanel";
import { UsageDashboard } from "./UsageDashboard";

let container: HTMLDivElement;
let root: Root;
let stored: Record<string, unknown>;

beforeEach(() => {
  stored = {};
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("chrome", { storage: { local: {
    get: vi.fn(async (key: string) => ({ [key]: stored[key] })),
    set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(stored, values); }),
  } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderSettings(initialSettings = DEFAULT_SETTINGS) {
  const changed = vi.fn();
  const save = vi.fn().mockResolvedValue(undefined);
  const testConnection = vi.fn().mockResolvedValue({ latencyMs: 42 });
  function Harness() {
    const [settings, setSettings] = useState(initialSettings);
    return <SettingsPanel settings={settings} onChange={(next) => { changed(next); setSettings(next); }} onSave={save} onTestConnection={testConnection} />;
  }
  await act(async () => root.render(<Harness />));
  vi.mocked(chrome.storage.local.set).mockClear();
  return { changed, save, testConnection };
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find((element) => element.textContent === text);
  expect(found).toBeDefined();
  return found!;
}

function seedProfile() {
  const profile = { ...DEFAULT_SETTINGS, id: "work", name: "Work", model: "saved-model", createdAt: 1, updatedAt: 1 };
  stored.byokAgentConfigProfiles = [profile];
  return profile;
}

function providerSelect(): HTMLSelectElement {
  const found = Array.from(container.querySelectorAll("select")).find((select) => select.closest("label")?.textContent?.startsWith("Provider"));
  expect(found).toBeDefined();
  return found!;
}

describe("model thinking setting", () => {
  function checkbox(): HTMLInputElement {
    const input = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
      .find((entry) => entry.closest("label")?.textContent?.includes("Disable model thinking"));
    expect(input).toBeDefined();
    return input!;
  }

  it("defaults to provider behavior and tests the currently selected thinking option", async () => {
    const settings: AgentSettings = { ...DEFAULT_SETTINGS, apiKey: "llm-key" };
    const { changed, testConnection } = await renderSettings(settings);
    expect(checkbox().checked).toBe(false);
    await act(async () => checkbox().click());
    expect(changed).toHaveBeenLastCalledWith({ ...settings, disableThinking: true });
    expect(checkbox().checked).toBe(true);
    expect(container.textContent).toContain("Provider/model support required");
    await act(async () => button("Test Connection").click());
    expect(testConnection).toHaveBeenCalledExactlyOnceWith({ ...settings, disableThinking: true }, undefined);
    await act(async () => checkbox().click());
    expect(changed).toHaveBeenLastCalledWith({ ...settings, disableThinking: false });
  });

  it("persists the toggle through Save & Update for the selected profile", async () => {
    const profile = seedProfile();
    await renderSettings();
    await act(async () => checkbox().click());
    await act(async () => button("Save").click());
    await act(async () => button("Save & Update").click());
    expect(stored.byokAgentConfigProfiles).toEqual(expect.arrayContaining([expect.objectContaining({ id: profile.id, disableThinking: true })]));
  });
});

describe("OpenAI endpoint setting", () => {
  function endpointSelect(): HTMLSelectElement | undefined {
    return Array.from(container.querySelectorAll("select")).find((select) => select.closest("label")?.textContent?.includes("OpenAI endpoint"));
  }

  async function choose(select: HTMLSelectElement, value: string) {
    await act(async () => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); });
  }

  it("defaults to Responses for api.openai.com and tests the selected endpoint", async () => {
    const settings: AgentSettings = { ...DEFAULT_SETTINGS, apiKey: "llm-key" };
    const { changed, testConnection } = await renderSettings(settings);
    expect(endpointSelect()?.value).toBe("responses");
    await choose(endpointSelect()!, "chat");
    expect(changed).toHaveBeenLastCalledWith({ ...settings, openAiApi: "chat" });
    expect(endpointSelect()?.value).toBe("chat");
    await act(async () => button("Test Connection").click());
    expect(testConnection).toHaveBeenCalledExactlyOnceWith({ ...settings, openAiApi: "chat" }, undefined);
  });

  it("shows the endpoint only for the OpenAI provider", async () => {
    await renderSettings({ ...DEFAULT_SETTINGS, openAiApi: "chat" });
    expect(endpointSelect()).toBeDefined();
    await choose(providerSelect(), "groq");
    expect(endpointSelect()).toBeUndefined();
  });
});

describe("settings save actions", () => {
  it("has one Save action next to Update and saves directly without a profile", async () => {
    const { save } = await renderSettings();
    expect(button("Update").nextElementSibling).toBe(button("Save"));
    expect(container.querySelectorAll('[aria-label="Save Settings"]')).toHaveLength(1);
    expect(container.querySelector(".settings-panel > button")).toBeNull();
    await act(async () => button("Save").click());
    expect(save).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Settings saved.");
  });

  it("prompts before saving and updates the selected profile only after confirmation", async () => {
    const profile = seedProfile();
    const { save } = await renderSettings({ ...DEFAULT_SETTINGS, model: "edited-model" });
    await act(async () => button("Save").click());
    expect(container.querySelector('[aria-label="Save settings confirmation"]')?.textContent).toContain('update "Work"');
    expect(save).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    await act(async () => button("Save & Update").click());
    expect(save).toHaveBeenCalledTimes(1);
    expect(stored.byokAgentConfigProfiles).toEqual(expect.arrayContaining([expect.objectContaining({ id: profile.id, name: "Work", model: "edited-model" })]));
    expect(container.textContent).toContain('Settings saved and "Work" updated.');
    expect(container.querySelector('[aria-label="Save settings confirmation"]')).toBeNull();
  });

  it("can save current settings without overwriting the stored profile", async () => {
    seedProfile();
    const { save } = await renderSettings({ ...DEFAULT_SETTINGS, model: "edited-model" });
    const originalProfiles = structuredClone(stored.byokAgentConfigProfiles);
    expect(originalProfiles).toEqual(expect.arrayContaining([expect.objectContaining({ id: "work", model: "saved-model" })]));
    await act(async () => button("Save").click());
    await act(async () => button("Save Only").click());
    expect(save).toHaveBeenCalledTimes(1);
    expect(stored.byokAgentConfigProfiles).toEqual(originalProfiles);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("can cancel without persisting settings or updating a profile", async () => {
    seedProfile();
    const { save } = await renderSettings();
    await act(async () => button("Save").click());
    await act(async () => button("Cancel").click());
    expect(save).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(button("Save").disabled).toBe(false);
  });

  it("does not update the profile when saving settings fails", async () => {
    seedProfile();
    const { save } = await renderSettings();
    save.mockRejectedValueOnce(new Error("Settings could not be saved."));
    await act(async () => button("Save").click());
    await act(async () => button("Save & Update").click());
    expect(save).toHaveBeenCalledTimes(1);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Settings could not be saved.");
    expect(button("Save & Update").disabled).toBe(false);
  });

  it("reports a profile failure separately from a successful settings save", async () => {
    seedProfile();
    const { save } = await renderSettings();
    vi.mocked(chrome.storage.local.set).mockRejectedValueOnce(new Error("Storage unavailable."));
    await act(async () => button("Save").click());
    await act(async () => button("Save & Update").click());
    expect(save).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Settings saved, but the profile update failed: Storage unavailable.");
    expect(button("Save & Update").disabled).toBe(false);
  });
});

describe("Jev settings", () => {
  function typeJevKey(value: string) {
    const input = container.querySelector<HTMLInputElement>(".jev-settings input[type=password]")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("offers only LLM providers and no separate planner selector", async () => {
    await renderSettings({ ...DEFAULT_SETTINGS, jev: { mode: "fast", apiKey: "jev-key" } });
    expect(Array.from(providerSelect().options).map((option) => option.value)).toEqual(["openai", "gemini", "groq", "custom"]);
    expect(providerSelect().value).toBe("openai");
    expect(container.textContent).not.toContain("LLM planner provider");
    expect(container.textContent).not.toContain("Jev Only");
  });

  it("keeps Jev settings when the provider changes", async () => {
    const settings: AgentSettings = { ...DEFAULT_SETTINGS, apiKey: "llm-key", jev: { mode: "shadow", apiKey: "jev-key" } };
    const { changed } = await renderSettings(settings);
    await act(async () => { providerSelect().value = "groq"; providerSelect().dispatchEvent(new Event("change", { bubbles: true })); });
    expect(changed.mock.lastCall?.[0]).toMatchObject({ provider: "groq", apiKey: "llm-key", jev: settings.jev });
  });

  it("turns Fast on when a key is entered and Jev off when the key is cleared", async () => {
    const { changed } = await renderSettings();
    await act(async () => typeJevKey("new-jev-key"));
    expect(changed.mock.lastCall?.[0].jev).toEqual({ mode: "fast", apiKey: "new-jev-key" });
    expect(button("Fast").getAttribute("aria-pressed")).toBe("true");
    await act(async () => typeJevKey(""));
    expect(changed.mock.lastCall?.[0].jev).toEqual({ mode: "off", apiKey: "" });
    expect(button("Fast").disabled).toBe(true);
  });

  it("keeps an explicit Off choice while an existing key is edited", async () => {
    const { changed } = await renderSettings({ ...DEFAULT_SETTINGS, jev: { mode: "off", apiKey: "jev-key" } });
    await act(async () => typeJevKey("jev-key-2"));
    expect(changed.mock.lastCall?.[0].jev).toEqual({ mode: "off", apiKey: "jev-key-2" });
  });

  it("keeps the current Jev settings when applying a profile", async () => {
    seedProfile();
    const settings: AgentSettings = { ...DEFAULT_SETTINGS, model: "current-model", jev: { mode: "fast", apiKey: "current-jev-key" } };
    const { changed } = await renderSettings(settings);
    await act(async () => button("Apply").click());
    expect(changed.mock.lastCall?.[0]).toMatchObject({ model: "saved-model", jev: settings.jev });
    expect(stored.byokAgentSettings).toMatchObject({ model: "saved-model", jev: settings.jev });
    expect(JSON.stringify(stored.byokAgentConfigProfiles)).not.toContain("current-jev-key");
  });

  it("defaults off and requires a key for active modes and connection testing", async () => {
    await renderSettings();
    expect(button("Off").getAttribute("aria-pressed")).toBe("true");
    expect(button("Shadow").disabled).toBe(true);
    expect(button("Fast").disabled).toBe(true);
    expect(button("Test Jev").disabled).toBe(true);
    expect(container.querySelector(".jev-settings input")?.getAttribute("type")).toBe("password");
  });

  it("switches modes while preserving both provider keys", async () => {
    const settings: AgentSettings = { ...DEFAULT_SETTINGS, apiKey: "llm-key", jev: { mode: "off", apiKey: "jev-key" } };
    const { changed } = await renderSettings(settings);
    await act(async () => button("Shadow").click());
    expect(changed).toHaveBeenLastCalledWith({ ...settings, jev: { mode: "shadow", apiKey: "jev-key" } });
    expect(button("Shadow").getAttribute("aria-pressed")).toBe("true");
    await act(async () => button("Fast").click());
    expect(changed).toHaveBeenLastCalledWith({ ...settings, jev: { mode: "fast", apiKey: "jev-key" } });
    await act(async () => button("Off").click());
    expect(changed).toHaveBeenLastCalledWith(settings);
  });

  it("tests Jev independently of the main model", async () => {
    const settings: AgentSettings = { ...DEFAULT_SETTINGS, jev: { mode: "shadow", apiKey: "jev-key" } };
    const { testConnection } = await renderSettings(settings);
    await act(async () => button("Test Jev").click());
    expect(testConnection).toHaveBeenCalledExactlyOnceWith(settings, "jev");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Jev connection successful (42 ms).");
    expect(button("Test Jev").disabled).toBe(false);
  });

  it("reports a failed Jev probe and re-enables testing", async () => {
    const { testConnection } = await renderSettings({ ...DEFAULT_SETTINGS, jev: { mode: "off", apiKey: "jev-key" } });
    testConnection.mockRejectedValueOnce(new Error("Jev returned HTTP 401."));
    await act(async () => button("Test Jev").click());
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Jev returned HTTP 401.");
    expect(button("Test Jev").disabled).toBe(false);
  });

  it("renders Jev counters separately from LLM pricing", () => {
    const usage: AgentUsageSnapshot = {
      requestCount: 1, successfulRequestCount: 1, cacheHitRequestCount: 0, promptTokens: 10,
      cachedPromptTokens: 0, completionTokens: 5, totalTokens: 15, totalLatencyMs: 2000,
      costConfigured: true, estimatedCostUsd: 0.1,
      jev: { requests: 2, fastDecisions: 1, shadowDecisions: 0, fallbacks: 1, inputTokens: 100, outputTokens: 20, totalLatencyMs: 400, estimatedCostUsd: 0.0000042 },
    };
    const markup = renderToStaticMarkup(<UsageDashboard usage={usage} />);
    expect(markup).toContain("Fast decisions");
    expect(markup).toContain("Text helper calls");
    expect(markup).toContain("200ms");
    expect(markup).toContain("$0.000004");
    expect(markup).toContain("$0.1000");
  });
});