import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../shared/defaults";
import type { AgentAction, AgentModelResponse, AgentSettings, JevSettings, RunReport, SidePanelToBackgroundMessage } from "../shared/types";
import type { ModelHttpRequest } from "./modelClient";

const mocks = vi.hoisted(() => ({ transport: vi.fn(), sendTabMessage: vi.fn(), notify: vi.fn(), activeTab: vi.fn(), capture: vi.fn() }));
vi.mock("./modelTransport", () => ({ registerModelTransportBroker: vi.fn(), requestModelThroughSidePanel: mocks.transport }));
vi.mock("./screenshot", async (importOriginal) => ({ ...await importOriginal<typeof import("./screenshot")>(), captureAndResizeVisibleTab: mocks.capture }));
vi.mock("./pdfText", () => ({ extractPdfText: vi.fn() }));
vi.mock("./chromeAsync", () => ({
  getActiveTab: mocks.activeTab, notifySidePanel: mocks.notify, sendTabMessage: mocks.sendTabMessage,
  sleep: vi.fn().mockResolvedValue(undefined), tryInjectContentScript: vi.fn(),
}));

let tab: { id: number; windowId: number; url: string; title: string; status: string; groupId: number };
let stored: Record<string, unknown>;
let onMessage: (message: SidePanelToBackgroundMessage, sender: unknown, respond: (value: unknown) => void) => void;
let jevConfidence: number;
let jevStatus: number;
let operationChoice: string | undefined;
let fieldValue: string;
let useField: boolean;
let journeyLength: number;
let navigationCount: number;

function observation() {
  const href = navigationCount < journeyLength - 1 ? `https://example.test/step-${navigationCount + 1}` : "https://example.test/docs/setup";
  return {
    documentId: `doc:${tab.url}`, isLoading: false, url: tab.url, title: tab.title, text: "Documentation links",
    elements: [
      { id: "el-1", fingerprint: `link:${tab.url}`, tag: "a", text: "Setup guide", href, isDisabled: false, isSensitive: false },
      ...(useField ? [{ id: "field", fingerprint: `field:${fieldValue}`, tag: "input", role: "searchbox", label: "Search", value: fieldValue, isDisabled: false, isSensitive: false }] : []),
    ],
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  tab = { id: 1, windowId: 1, url: "https://example.test/docs/home", title: "Docs", status: "complete", groupId: -1 };
  stored = {};
  jevConfidence = 0.99;
  jevStatus = 200;
  operationChoice = undefined;
  fieldValue = "";
  useField = false;
  journeyLength = 1;
  navigationCount = 0;
  const event = () => ({ addListener: vi.fn() });
  vi.stubGlobal("chrome", {
    runtime: {
      onInstalled: event(), onStartup: event(),
      onMessage: { addListener: (listener: typeof onMessage) => { onMessage = listener; } },
    },
    action: { onClicked: event() }, commands: { onCommand: event() },
    sidePanel: { setPanelBehavior: vi.fn().mockResolvedValue(undefined), setOptions: vi.fn().mockResolvedValue(undefined) },
    tabs: { onCreated: event(), onRemoved: event(), get: vi.fn(async () => ({ ...tab })) },
    downloads: { onChanged: event(), search: vi.fn().mockResolvedValue([]) },
    storage: { local: {
      get: vi.fn(async (key: string) => ({ [key]: stored[key] })),
      set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(stored, values); }),
    } },
  });
  mocks.activeTab.mockImplementation(async () => ({ ...tab }));
  mocks.sendTabMessage.mockImplementation(async (_tabId: number, message: { type: string; action?: AgentAction }) => {
    if (message.type === "CONTENT_CHECK_WAIT") {
      return { matched: true, signature: JSON.stringify(observation()), readyState: "complete", url: tab.url };
    }
    if (message.type === "CONTENT_EXECUTE") {
      expect(message.action?.guard?.documentId).toBe(`doc:${tab.url}`);
      if (message.action?.type === "navigate") tab.url = message.action.url!;
      else if (message.action?.type === "click") { tab.url = observation().elements[0].href!; navigationCount += 1; }
      else if (message.action?.type === "fill") fieldValue = message.action.text!;
      else throw new Error(`Unexpected action ${message.action?.type}`);
      return { ok: true, message: "Action completed", observation: observation() };
    }
    expect(message.type).toBe("CONTENT_OBSERVE");
    return observation();
  });
  mocks.transport.mockImplementation(async (request: ModelHttpRequest) => {
    if (request.endpoint.includes("api.typesafe.ai")) {
      const body = JSON.parse(request.body);
      const questions = body.questions as Record<string, { criteria: Record<string, string> }>;
      const operation = operationChoice || (tab.url.endsWith("/setup") ? "done" : useField && !fieldValue ? "fill" : "click");
      return {
        ok: jevStatus === 200, status: jevStatus, statusText: "Jev result",
        responseText: JSON.stringify({ answers: Object.fromEntries(Object.entries(questions).map(([name, question]) => {
          const choice = name === "operation" ? operation : name === "completion" ? "verified" : name === "click_target" ? "el-1"
            : name === "fill_target" ? "field" : name === "fill_value" ? ("value_1" in question.criteria ? "value_1" : "generate") : "fallback";
          return [name, { type: "choice", choice, confidence: jevConfidence, probabilities: Object.fromEntries(Object.keys(question.criteria).map((option) => [option, Number(option === choice)])) }];
        })), usage: { input_tokens: 100, output_tokens: 20 } }),
      };
    }
    if (JSON.parse(request.body).max_tokens === 1024) {
      return { ok: true, status: 200, statusText: "OK", responseText: JSON.stringify({ choices: [{ message: { content: '{"text":"typescript"}' } }], usage: { prompt_tokens: 30, completion_tokens: 5 } }) };
    }
    const response: AgentModelResponse = {
      mode: "browser", risk_level: "low", thought_summary: "Read documentation",
      action: tab.url.endsWith("/home") ? { type: "navigate", url: "https://example.test/docs/index" }
        : tab.url.endsWith("/index") ? { type: "navigate", url: "https://example.test/docs/setup" }
          : { type: "ask_user", text: "Setup guide reached." },
      navigationGoal: tab.url.endsWith("/home") ? "Find the setup guide" : undefined,
      requirements: [{ text: "Find the setup guide" }],
    };
    return {
      ok: true, status: 200, statusText: "OK",
      responseText: JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }], usage: { prompt_tokens: 200, completion_tokens: 40 } }),
    };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function send(message: SidePanelToBackgroundMessage): Promise<unknown> {
  return new Promise((resolve) => onMessage(message, {}, resolve));
}

async function start(mode: JevSettings["mode"], overrides: Partial<AgentSettings> = {}, task = "Find the setup guide", source: "run" | "chat" = "run") {
  const settings: AgentSettings = { ...DEFAULT_SETTINGS, apiKey: "llm-key", apiBaseUrl: "https://llm.example/v1", jev: { mode, apiKey: "jev-key" }, ...overrides };
  stored.byokAgentSettings = settings;
  await import("./index");
  await send(source === "chat" ? { type: "SIDEPANEL_SEND_CHAT", message: task, settings } : { type: "SIDEPANEL_RUN_TASK", task, settings });
}

function requests(provider: "jev" | "llm"): ModelHttpRequest[] {
  return mocks.transport.mock.calls.map(([request]) => request as ModelHttpRequest)
    .filter((request) => request.endpoint.includes("api.typesafe.ai") === (provider === "jev"));
}

function llmActionResponse(action: AgentAction) {
  return {
    ok: true, status: 200, statusText: "OK",
    responseText: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      mode: "browser", risk_level: "low", thought_summary: "Recover the browser task", action,
      requirements: [{ text: "Find the setup guide" }],
    }) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }),
  };
}

describe("Jev background loop integration", () => {
  it("returns to Jev after one successful LLM recovery batch with a fresh page and history", async () => {
    jevConfidence = 0.6;
    const original = mocks.transport.getMockImplementation()!;
    mocks.transport.mockImplementation(async (request: ModelHttpRequest) => {
      const result = await original(request);
      if (!request.endpoint.includes("api.typesafe.ai")) jevConfidence = 0.99;
      return result;
    });
    await start("fast");
    await waitForAnswer("Jev verified");
    expect(requests("llm")).toHaveLength(1);
    expect(requests("jev")).toHaveLength(3);
    expect(mocks.transport.mock.calls.map(([request]) => request.endpoint.includes("api.typesafe.ai") ? "jev" : "llm")).toEqual(["jev", "llm", "jev", "jev"]);
    const resumedState = JSON.parse(requests("jev")[1].body).state;
    expect(resumedState.page.url).toBe("https://example.test/docs/index");
    expect(resumedState.recentActions).toEqual([expect.objectContaining({ action: "LLM recovery batch", result: expect.stringContaining("navigate") })]);
    expect(navigationCount).toBe(1);
    expect(mocks.notify.mock.calls.some(([message]) => message.type === "AGENT_LOG" && message.entry.message.includes("Returning control to Jev"))).toBe(true);
  });

  it("stops returning to Jev after two unproductive returns even though LLM actions continue", async () => {
    jevConfidence = 0.6;
    let plannerCalls = 0;
    const original = mocks.transport.getMockImplementation()!;
    mocks.transport.mockImplementation(async (request: ModelHttpRequest) => {
      if (request.endpoint.includes("api.typesafe.ai")) return original(request);
      plannerCalls += 1;
      return llmActionResponse(plannerCalls <= 5
        ? { type: "navigate", url: `https://example.test/docs/recovery-${plannerCalls}` }
        : { type: "ask_user", text: "LLM continued after bounded Jev retries." });
    });
    await start("fast");
    await waitForAnswer("LLM continued after bounded Jev retries");
    expect(requests("jev")).toHaveLength(3);
    expect(requests("llm")).toHaveLength(6);
    expect(mocks.sendTabMessage.mock.calls.filter(([, message]) => message.type === "CONTENT_EXECUTE")).toHaveLength(5);
    expect(mocks.notify.mock.calls.filter(([message]) => message.type === "AGENT_LOG" && message.entry.message.includes("returned without executing actions twice"))).toHaveLength(1);
  });

  it("waits for the answer-and-Continue batch before returning the next question to Jev", async () => {
    jevConfidence = 0.6;
    let selected = false;
    let continued = false;
    const quizPage = () => ({
      ...observation(), text: continued ? "Question 2" : "Question 1",
      elements: [
        { id: "el-1", fingerprint: `option-${selected}`, tag: "input", type: "radio", label: "Option A", checkedState: selected ? "checked" : "unchecked", isDisabled: false, isSensitive: false },
        { id: "continue", fingerprint: "continue-button", tag: "button", label: "Continue", isDisabled: false, isSensitive: false },
      ],
    });
    const originalContent = mocks.sendTabMessage.getMockImplementation()!;
    mocks.sendTabMessage.mockImplementation(async (tabId: number, message: { type: string; action?: AgentAction }) => {
      if (message.type === "CONTENT_OBSERVE") return quizPage();
      if (message.type === "CONTENT_EXECUTE") {
        expect(message.action?.type).toBe("click");
        if (message.action?.elementId === "el-1") selected = true;
        else {
          expect(selected).toBe(true);
          expect(message.action?.elementId).toBe("continue");
          continued = true;
        }
        return { ok: true, message: continued ? "Clicked Continue" : "Selected Option A", observation: quizPage() };
      }
      return originalContent(tabId, message);
    });
    const originalTransport = mocks.transport.getMockImplementation()!;
    mocks.transport.mockImplementation(async (request: ModelHttpRequest) => {
      if (request.endpoint.includes("api.typesafe.ai")) {
        if (continued) {
          expect(JSON.parse(request.body).state.page.text).toBe("Question 2");
          operationChoice = "done";
        }
        return originalTransport(request);
      }
      jevConfidence = 0.99;
      return {
        ok: true, status: 200, statusText: "OK",
        responseText: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ mode: "browser", risk_level: "low", thought_summary: "Answer then continue", actions: [
          { type: "click", elementId: "el-1" }, { type: "click", elementId: "continue" },
        ] }) } }] }),
      };
    });
    await start("fast");
    await waitForAnswer("Jev verified");
    expect(continued).toBe(true);
    expect(requests("llm")).toHaveLength(1);
    expect(requests("jev")).toHaveLength(2);
    const resumed = JSON.parse(requests("jev")[1].body).state;
    expect(resumed.page.text).toBe("Question 2");
    expect(resumed.recentActions[0].result).toContain("Continue");
    expect(mocks.sendTabMessage.mock.calls.filter(([, message]) => message.type === "CONTENT_EXECUTE")).toHaveLength(2);
  });

  it("resets the failed-return count after Jev actually executes an action", async () => {
    let jevCalls = 0;
    let plannerCalls = 0;
    const original = mocks.transport.getMockImplementation()!;
    mocks.transport.mockImplementation(async (request: ModelHttpRequest) => {
      if (request.endpoint.includes("api.typesafe.ai")) {
        jevCalls += 1;
        jevConfidence = [1, 2, 4, 5].includes(jevCalls) ? 0.6 : 0.99;
        operationChoice = jevCalls === 6 ? "done" : undefined;
        return original(request);
      }
      plannerCalls += 1;
      return llmActionResponse({ type: "navigate", url: `https://example.test/docs/recovery-${plannerCalls}` });
    });
    await start("fast");
    await waitForAnswer("Jev verified");
    expect(requests("jev")).toHaveLength(6);
    expect(requests("llm")).toHaveLength(4);
    expect(navigationCount).toBe(1);
    const lastState = JSON.parse(requests("jev")[5].body).state;
    expect(lastState.recentActions.filter((entry: { action: string }) => entry.action === "LLM recovery batch")).toHaveLength(4);
    expect(lastState.recentActions.some((entry: { action: string }) => entry.action === "click")).toBe(true);
  });

  it("does not return to Jev when the LLM action leaves the page unchanged", async () => {
    jevConfidence = 0.6;
    let plannerCalls = 0;
    const originalTransport = mocks.transport.getMockImplementation()!;
    mocks.transport.mockImplementation(async (request: ModelHttpRequest) => {
      if (request.endpoint.includes("api.typesafe.ai")) return originalTransport(request);
      plannerCalls += 1;
      return llmActionResponse(plannerCalls === 1 ? { type: "click", elementId: "el-1" } : { type: "ask_user", text: "Page remained unchanged." });
    });
    const originalContent = mocks.sendTabMessage.getMockImplementation()!;
    mocks.sendTabMessage.mockImplementation(async (tabId: number, message: { type: string }) => message.type === "CONTENT_EXECUTE"
      ? { ok: true, message: "Clicked without page changes", observation: observation() } : originalContent(tabId, message));
    await start("fast");
    await waitForAnswer("Page remained unchanged");
    expect(requests("jev")).toHaveLength(1);
    expect(requests("llm")).toHaveLength(2);
    expect(mocks.sendTabMessage.mock.calls.filter(([, message]) => message.type === "CONTENT_EXECUTE")).toHaveLength(1);
  });

  it("keeps the LLM in control when its recovery batch fails even if the page changes", async () => {
    jevConfidence = 0.6;
    let plannerCalls = 0;
    const originalTransport = mocks.transport.getMockImplementation()!;
    mocks.transport.mockImplementation(async (request: ModelHttpRequest) => {
      if (request.endpoint.includes("api.typesafe.ai")) return originalTransport(request);
      plannerCalls += 1;
      return llmActionResponse(plannerCalls === 1 ? { type: "click", elementId: "el-1" } : { type: "ask_user", text: "Recovery needs inspection." });
    });
    const originalContent = mocks.sendTabMessage.getMockImplementation()!;
    mocks.sendTabMessage.mockImplementation(async (tabId: number, message: { type: string }) => {
      if (message.type === "CONTENT_EXECUTE") {
        tab.title = "The page changed during the failed attempt";
        return { ok: false, recoverable: true, message: "Unverified click", observation: observation() };
      }
      return originalContent(tabId, message);
    });
    await start("fast");
    await waitForAnswer("Recovery needs inspection");
    expect(requests("jev")).toHaveLength(1);
    expect(requests("llm")).toHaveLength(2);
    expect(mocks.sendTabMessage.mock.calls.filter(([, message]) => message.type === "CONTENT_EXECUTE")).toHaveLength(1);
  });

  it("lets the LLM consume a pending read_page result before a Jev return", async () => {
    jevConfidence = 0.6;
    let plannerCalls = 0;
    const originalTransport = mocks.transport.getMockImplementation()!;
    mocks.transport.mockImplementation(async (request: ModelHttpRequest) => {
      if (request.endpoint.includes("api.typesafe.ai")) return originalTransport(request);
      plannerCalls += 1;
      return llmActionResponse(plannerCalls === 1 ? { type: "read_page" } : { type: "ask_user", text: "Document received by the planner." });
    });
    const originalContent = mocks.sendTabMessage.getMockImplementation()!;
    mocks.sendTabMessage.mockImplementation(async (tabId: number, message: { type: string }) => {
      if (message.type === "CONTENT_READ_PAGE") {
        tab.title = "Document loaded";
        return { url: tab.url, title: tab.title, markdown: "Unique full-page context", sourceCharacters: 24, truncated: false };
      }
      return originalContent(tabId, message);
    });
    await start("fast");
    await waitForAnswer("Document received by the planner");
    expect(requests("jev")).toHaveLength(1);
    expect(requests("llm")).toHaveLength(2);
    expect(JSON.stringify(JSON.parse(requests("llm")[1].body).messages)).toContain("Unique full-page context");
  });

  it("cancels a resumed Jev request without another LLM handoff", async () => {
    jevConfidence = 0.6;
    let jevCalls = 0;
    const original = mocks.transport.getMockImplementation()!;
    mocks.transport.mockImplementation((request: ModelHttpRequest) => {
      if (request.endpoint.includes("api.typesafe.ai") && ++jevCalls === 2) {
        return new Promise<never>((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
      }
      return original(request);
    });
    await start("fast");
    await vi.waitFor(() => expect(requests("jev")).toHaveLength(2));
    await send({ type: "SIDEPANEL_STOP_TASK" });
    await vi.waitFor(async () => expect(await send({ type: "SIDEPANEL_GET_STATE" })).toMatchObject({ running: false, waitingForModel: false }));
    expect(requests("jev")[1].signal.aborted).toBe(true);
    expect(requests("llm")).toHaveLength(1);
    expect(mocks.sendTabMessage.mock.calls.filter(([, message]) => message.type === "CONTENT_EXECUTE")).toHaveLength(1);
  });

  it("does not fall back when only an unused speculative answer has invalid probabilities", async () => {
    const original = mocks.transport.getMockImplementation()!;
    mocks.transport.mockImplementation(async (request: ModelHttpRequest) => {
      const result = await original(request);
      if (request.endpoint.includes("api.typesafe.ai")) {
        const body = JSON.parse(result.responseText);
        if (body.answers.operation.choice === "click") {
          body.answers.completion.probabilities = { verified: 0.8, incomplete: 0.8 };
          result.responseText = JSON.stringify(body);
        }
      }
      return result;
    });
    await start("fast");
    await waitForAnswer("Jev verified");
    expect(navigationCount).toBe(1);
    expect(requests("jev")).toHaveLength(2);
    expect(requests("llm")).toHaveLength(0);
    expect(mocks.notify.mock.calls.some(([message]) => message.type === "AGENT_LOG" && message.entry.message.includes("ignored invalid unused answers: completion"))).toBe(true);
  });

  it("still refuses malformed probabilities for the target that would execute", async () => {
    const original = mocks.transport.getMockImplementation()!;
    mocks.transport.mockImplementation(async (request: ModelHttpRequest) => {
      const result = await original(request);
      if (request.endpoint.includes("api.typesafe.ai")) {
        const body = JSON.parse(result.responseText);
        body.answers.click_target.probabilities = { "el-1": 0.3, fallback: 0.2 };
        result.responseText = JSON.stringify(body);
      }
      return result;
    });
    await start("fast");
    await waitForAnswer("Setup guide reached.");
    expect(requests("jev")).toHaveLength(1);
    expect(requests("llm")).toHaveLength(3);
    const firstPlannerMessages = JSON.parse(requests("llm")[0].body).messages as Array<{ content: unknown }>;
    expect(firstPlannerMessages.some((message) => typeof message.content === "string" && message.content.includes('invalid probabilities for "click_target": sum=0.500000'))).toBe(true);
    expect(mocks.sendTabMessage.mock.calls.filter(([, message]) => message.action?.type === "click")).toHaveLength(0);
    expect(navigationCount).toBe(0);
  });

  it("recovers from a stale form ID, scrolls with PageUp, then fills a current field", async () => {
    useField = true;
    const plans: AgentAction[] = [
      { type: "fill", elementId: "old-el-19", text: "2" },
      { type: "press_key", key: "PageUp" },
      { type: "fill", elementId: "field", text: "2" },
      { type: "ask_user", text: "Recovered and filled the current field." },
    ];
    let responseIndex = 0;
    mocks.transport.mockImplementation(async () => ({ ok: true, status: 200, statusText: "OK", responseText: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      mode: "browser", risk_level: "high", thought_summary: "Continue the form", action: plans[responseIndex++], requirements: [{ text: "Fill the remaining field" }],
    }) } }] }) }));
    const original = mocks.sendTabMessage.getMockImplementation()!;
    mocks.sendTabMessage.mockImplementation(async (tabId: number, message: { type: string; action?: AgentAction }) => {
      if (message.type === "CONTENT_EXECUTE" && message.action?.type === "press_key") {
        expect(message.action.key).toBe("PageUp");
        return { ok: true, message: "Scrolled up in form panel", observation: observation() };
      }
      return original(tabId, message);
    });
    await start("off", {}, "Fill the unanswered form fields");
    await waitForAnswer("Recovered and filled the current field");
    expect(fieldValue).toBe("2");
    const actions = mocks.sendTabMessage.mock.calls.filter(([, message]) => message.type === "CONTENT_EXECUTE").map(([, message]) => message.action);
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({ type: "press_key", key: "PageUp" });
    expect(actions[1]).toMatchObject({ type: "fill", elementId: "field" });
    expect(JSON.stringify(JSON.parse(requests("llm")[1].body).messages)).toContain("not currently observed");
  });

  it("attaches raw model output to the Console warning for non-JSON output and continues", async () => {
    const prose = "Sure! I will open the setup guide now.";
    let calls = 0;
    mocks.transport.mockImplementation(async () => {
      calls += 1;
      return calls === 1
        ? { ok: true, status: 200, statusText: "OK", responseText: JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: prose } }] }) }
        : llmActionResponse({ type: "ask_user", text: "Recovered after invalid JSON." });
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await start("off");
    await waitForAnswer("Recovered after invalid JSON");
    const warning = mocks.notify.mock.calls.map(([message]) => message)
      .find((message) => message.type === "AGENT_LOG" && message.entry.message.includes("did not return strict JSON"));
    expect(warning?.entry.level).toBe("warning");
    expect(warning?.entry.message).toContain("Asking the model to continue with valid action JSON.");
    expect(warning?.entry.details).toContain("finish_reason=stop");
    expect(warning?.entry.details).toContain(prose);
    expect(requests("llm")).toHaveLength(2);
    expect(JSON.stringify(JSON.parse(requests("llm")[1].body).messages)).toContain("did not return strict JSON (");
  });

  it("executes no browser action for conflicting plans and asks the model again", async () => {
    const plan = (url: string) => JSON.stringify({ mode: "browser", risk_level: "low", thought_summary: "Navigate", action: { type: "navigate", url } });
    const content = `${plan("https://example.test/docs/wrong")}}\n<|im_end|>\nOops, wrong page.${plan("https://example.test/docs/setup")}`;
    let calls = 0;
    mocks.transport.mockImplementation(async () => {
      calls += 1;
      return calls === 1
        ? { ok: true, status: 200, statusText: "OK", responseText: JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }) }
        : llmActionResponse({ type: "ask_user", text: "Retried after conflicting plans." });
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await start("off");
    await waitForAnswer("Retried after conflicting plans");
    expect(mocks.sendTabMessage.mock.calls.filter(([, message]) => message.type === "CONTENT_EXECUTE")).toHaveLength(0);
    expect(tab.url).toBe("https://example.test/docs/home");
    expect(requests("llm")).toHaveLength(2);
    const warning = mocks.notify.mock.calls.map(([message]) => message)
      .find((message) => message.type === "AGENT_LOG" && message.entry.message.includes("conflicting JSON action plans"));
    expect(warning?.entry.details).toContain("Leaked chat-template token <|im_end|>");
    expect(JSON.stringify(JSON.parse(requests("llm")[1].body).messages)).toContain("so none were executed");
  });

  it("attaches a screenshot after two failed steps, at most three times per run", async () => {
    useField = true;
    let calls = 0;
    mocks.transport.mockImplementation(async () => {
      calls += 1;
      return llmActionResponse(calls <= 8 ? { type: "fill", elementId: "field", text: `answer ${calls}` } : { type: "ask_user", text: "Still blocked by the overlay." });
    });
    const original = mocks.sendTabMessage.getMockImplementation()!;
    mocks.sendTabMessage.mockImplementation(async (tabId: number, message: { type: string; action?: AgentAction }) => message.type === "CONTENT_EXECUTE"
      ? { ok: false, recoverable: true, notExecuted: true, message: "The selected target is covered by <div#cookie-modal>.", observation: observation() }
      : original(tabId, message));
    mocks.capture.mockResolvedValue("data:image/jpeg;base64,stuck");
    Object.assign((globalThis as unknown as { chrome: { tabs: Record<string, unknown> } }).chrome.tabs, { query: vi.fn(async () => [{ ...tab }]) });
    await start("off");
    await waitForAnswer("Still blocked by the overlay");
    expect(fieldValue).toBe("");
    const withImage = requests("llm").map((request, index) => ({ index: index + 1, content: JSON.parse(request.body).messages.at(-1).content }))
      .filter(({ content }) => Array.isArray(content));
    expect(requests("llm")).toHaveLength(9);
    expect(withImage.map(({ index }) => index)).toEqual([3, 5, 7]);
    for (const { content } of withImage) {
      expect(content).toContainEqual({ type: "image_url", image_url: { url: "data:image/jpeg;base64,stuck", detail: "low" } });
      expect(content[0].text).toContain("The last 2 steps failed, so a screenshot of what is on screen is attached.");
    }
    expect(mocks.capture).toHaveBeenCalledTimes(3);
    const logs = mocks.notify.mock.calls.map(([message]) => message).filter((message) => message.type === "AGENT_LOG" && message.entry.message.startsWith("Stuck after 2 failed steps"));
    expect(logs.map((message) => message.entry.message)).toEqual([1, 2, 3].map((count) => expect.stringContaining(`automatic screenshot ${count} of 3`)));
  });

  describe("final completion check", () => {
    const flattenedRejection = '```json\n{\n  "actionType": "ask_user",\n  "text": "Cannot confirm task completion. The field value is not shown."\n}\n```';

    function routeValidator(validatorReplies: string[]) {
      let plannerCalls = 0;
      let validatorCalls = 0;
      mocks.transport.mockImplementation(async (request: ModelHttpRequest) => {
        const messages = JSON.parse(request.body).messages as Array<{ role: string; content: string }>;
        if (messages[0].content.startsWith("You validate completion")) {
          const content = validatorReplies[validatorCalls++];
          return { ok: true, status: 200, statusText: "OK", responseText: JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }) };
        }
        plannerCalls += 1;
        const prompt = messages.map((message) => message.content).join("\n");
        if (plannerCalls === 1) return llmActionResponse({ type: "fill", elementId: "field", text: "3" });
        if (plannerCalls === 2) {
          const requirementId = /- (req-[\w-]+) status=/.exec(prompt)![1];
          const evidenceId = /- (evidence-[\w-]+) kind=action/.exec(prompt)![1];
          return { ok: true, status: 200, statusText: "OK", responseText: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
            mode: "browser", risk_level: "low", thought_summary: "All fields filled",
            requirementUpdates: [{ requirementId, status: "satisfied", evidenceIds: [evidenceId] }],
            action: { type: "done", outcome: "completed", text: "Filled the field with 3." },
          }) } }] }) };
        }
        return llmActionResponse({ type: "ask_user", text: "Stopped after validator feedback." });
      });
    }

    it("accepts a flattened ask_user verdict as a rejection and continues with its reason", async () => {
      useField = true;
      routeValidator([flattenedRejection]);
      await start("off");
      await waitForAnswer("Stopped after validator feedback");
      const planner = requests("llm").filter((request) => !JSON.parse(request.body).messages[0].content.startsWith("You validate completion"));
      expect(planner).toHaveLength(3);
      expect(requests("llm")).toHaveLength(4);
      expect(JSON.stringify(JSON.parse(planner[2].body).messages)).toContain("Completion rejected by final validation: Cannot confirm task completion.");
      await vi.waitFor(() => {
        const evidence = (stored.byokAgentRunReports as RunReport[])[0].evidence.filter((item) => item.kind === "action");
        expect(evidence.map((item) => item.summary)).toEqual([expect.stringContaining('[label "Search", value "3"]')]);
      });
    });

    it("stops with an unverified report after two unusable verdicts", async () => {
      useField = true;
      routeValidator(["I think it is done.", "Looks complete to me."]);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await start("off");
      await waitForAnswer("Unverified: the final completion check returned unusable output twice");
      expect(requests("llm")).toHaveLength(4);
      await vi.waitFor(() => expect((stored.byokAgentRunReports as RunReport[])[0].status).toBe("blocked"));
    });
  });

  it("does not inject a Tab action when an LLM repeats a completed fill", async () => {
    useField = true;
    let responseIndex = 0;
    const plans: AgentAction[] = [{ type: "fill", elementId: "field", text: "2" }, { type: "fill", elementId: "field", text: "2" }, { type: "ask_user", text: "Duplicate skipped without focus changes." }];
    mocks.transport.mockImplementation(async () => ({ ok: true, status: 200, statusText: "OK", responseText: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      mode: "browser", risk_level: "low", thought_summary: "Fill", action: plans[responseIndex++],
    }) } }] }) }));
    await start("off");
    await waitForAnswer("Duplicate skipped without focus changes");
    const actions = mocks.sendTabMessage.mock.calls.filter(([, message]) => message.type === "CONTENT_EXECUTE").map(([, message]) => message.action);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("fill");
    expect(fieldValue).toBe("2");
  });

  it.each([
    { mode: "fast", confidence: 0.99, status: 200, llmCalls: 0, jevCalls: 2, skipped: 2 },
    { mode: "shadow", confidence: 0.99, status: 200, llmCalls: 3, jevCalls: 3, skipped: 0 },
    { mode: "off", confidence: 0.99, status: 200, llmCalls: 3, jevCalls: 0, skipped: 0 },
    { mode: "fast", confidence: 0.6, status: 200, llmCalls: 3, jevCalls: 3, skipped: 0 },
    { mode: "fast", confidence: 0.99, status: 429, llmCalls: 3, jevCalls: 1, skipped: 0 },
  ] as const)("runs $mode with confidence $confidence and HTTP $status", async (scenario) => {
    jevConfidence = scenario.confidence;
    jevStatus = scenario.status;
    await start(scenario.mode);
    await vi.waitFor(() => {
      expect(mocks.notify.mock.calls.some(([message]) => message.type === "AGENT_CHAT_MESSAGE" && message.message.role === "assistant"
        && (message.message.content.includes("Jev verified") || message.message.content === "Setup guide reached."))).toBe(true);
    });
    expect(requests("llm")).toHaveLength(scenario.llmCalls);
    expect(requests("jev")).toHaveLength(scenario.jevCalls);
    expect(tab.url).toBe("https://example.test/docs/setup");
    const executed = mocks.sendTabMessage.mock.calls.filter(([, message]) => message.type === "CONTENT_EXECUTE");
    expect(executed.map(([, message]) => message.action.type)).toEqual(scenario.llmCalls ? ["navigate", "navigate"] : ["click"]);
    const state = await send({ type: "SIDEPANEL_GET_STATE" }) as { running: boolean; usage: { jev?: { fastDecisions: number; requests: number } } };
    expect(state.running).toBe(false);
    expect(state.usage.jev?.fastDecisions || 0).toBe(scenario.skipped);
    expect(state.usage.jev?.requests || 0).toBe(scenario.jevCalls);
  });

  it("cancels fast mode on Stop without starting another LLM call", async () => {
    const original = mocks.transport.getMockImplementation()!;
    mocks.transport.mockImplementation((request: ModelHttpRequest) => request.endpoint.includes("api.typesafe.ai")
      ? new Promise<never>((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))))
      : original(request));
    await start("fast");
    await vi.waitFor(() => expect(requests("jev")).toHaveLength(1));
    await send({ type: "SIDEPANEL_STOP_TASK" });
    await vi.waitFor(async () => {
      const state = await send({ type: "SIDEPANEL_GET_STATE" }) as { running: boolean; waitingForModel: boolean };
      expect(state).toMatchObject({ running: false, waitingForModel: false });
    });
    expect(requests("jev")[0].signal.aborted).toBe(true);
    expect(requests("llm")).toHaveLength(0);
    expect(tab.url).toBe("https://example.test/docs/home");
  });
});

async function waitForAnswer(text: string) {
  await vi.waitFor(() => {
    expect(mocks.notify.mock.calls.some(([message]) => message.type === "AGENT_CHAT_MESSAGE"
      && message.message.role === "assistant" && message.message.content.includes(text))).toBe(true);
  });
}

describe("Jev runtime selection", () => {
  it.each(["run", "chat"] as const)("uses the visible Jev key for %s even when storage has no Jev key", async (source) => {
    stored.byokAgentSettings = { ...DEFAULT_SETTINGS, apiKey: "old-llm-key", model: "gemma-4-31b", jev: { mode: "off", apiKey: "" } };
    const settings: AgentSettings = { ...DEFAULT_SETTINGS, apiKey: "llm-key", apiBaseUrl: "https://llm.example/v1", jev: { mode: "fast", apiKey: "jev-key" } };
    await import("./index");
    await send(source === "chat"
      ? { type: "SIDEPANEL_SEND_CHAT", message: "Find the setup guide", settings }
      : { type: "SIDEPANEL_RUN_TASK", task: "Find the setup guide", settings });
    await waitForAnswer("Jev verified the requested browser outcome");
    expect(requests("jev")).toHaveLength(2);
    expect(requests("llm")).toHaveLength(0);
    expect(tab.url).toBe("https://example.test/docs/setup");
  });

  it("uses only the LLM when Fast is selected without a Jev key", async () => {
    await start("fast", { jev: { mode: "fast", apiKey: "" } });
    await waitForAnswer("Setup guide reached.");
    expect(requests("jev")).toHaveLength(0);
    expect(requests("llm")).toHaveLength(3);
    expect(tab.url).toBe("https://example.test/docs/setup");
  });

  it("rejects old task messages without a configuration instead of guessing a provider", async () => {
    stored.byokAgentSettings = { ...DEFAULT_SETTINGS, apiKey: "old-llm-key" };
    await import("./index");
    const response = await send({ type: "SIDEPANEL_SEND_CHAT", message: "Hello" } as SidePanelToBackgroundMessage);
    expect(response).toMatchObject({ ok: false, error: expect.stringContaining("no selected configuration") });
    expect(mocks.transport).not.toHaveBeenCalled();
  });

  it.each(["run", "chat"] as const)("completes and persists a %s navigation with zero LLM requests", async (source) => {
    await start("fast", {}, "Find the setup guide", source);
    await waitForAnswer("Jev verified the requested browser outcome");
    expect(tab.url).toBe("https://example.test/docs/setup");
    expect(requests("jev")).toHaveLength(2);
    expect(requests("llm")).toHaveLength(0);
    const executed = mocks.sendTabMessage.mock.calls.filter(([, message]) => message.type === "CONTENT_EXECUTE");
    expect(executed).toHaveLength(1);
    expect(executed[0][1].action).toMatchObject({ type: "click", elementId: "el-1", guard: { documentId: "doc:https://example.test/docs/home" } });
    await vi.waitFor(() => {
      const reports = stored.byokAgentRunReports as RunReport[];
      expect(reports?.[0]).toMatchObject({ status: "completed", usage: { requestCount: 0, jev: { requests: 2, fastDecisions: 2 } } });
      expect(reports[0].requirements[0]).toMatchObject({ status: "satisfied", evidenceIds: [expect.any(String)] });
    });
  });

  it("continues beyond the LLM step limit until Jev reaches the destination", async () => {
    journeyLength = 12;
    await start("fast", { maxSteps: 1 });
    await waitForAnswer("Jev verified the requested browser outcome");
    expect(navigationCount).toBe(12);
    expect(requests("llm")).toHaveLength(0);
    expect(requests("jev")).toHaveLength(13);
  });

  it("fills exact quoted user text without a helper LLM call", async () => {
    useField = true;
    await start("fast", {}, 'Search for "typescript" and open the result');
    await waitForAnswer("Jev verified");
    expect(fieldValue).toBe("typescript");
    expect(requests("llm")).toHaveLength(0);
    expect(mocks.sendTabMessage.mock.calls.filter(([, message]) => message.type === "CONTENT_EXECUTE").map(([, message]) => message.action.type)).toEqual(["fill", "click"]);
  });

  it("uses one hybrid helper call, reusing its value after an explicitly unexecuted stale refusal", async () => {
    useField = true;
    const original = mocks.sendTabMessage.getMockImplementation()!;
    let refused = false;
    mocks.sendTabMessage.mockImplementation(async (tabId: number, message: { type: string; action?: AgentAction }) => {
      if (message.action?.type === "fill" && !refused) { refused = true; return { ok: false, recoverable: true, notExecuted: true, message: "Stale read" }; }
      return original(tabId, message);
    });
    await start("fast", {}, "Search for typescript and open the result");
    await waitForAnswer("Jev verified");
    expect(refused).toBe(true);
    expect(fieldValue).toBe("typescript");
    expect(requests("llm")).toHaveLength(1);
    expect(JSON.parse(requests("llm")[0].body).max_tokens).toBe(1024);
  });

  it("discards generated text if the page context changes during the helper call", async () => {
    useField = true;
    let helperCalls = 0;
    const original = mocks.transport.getMockImplementation()!;
    mocks.transport.mockImplementation(async (request: ModelHttpRequest) => {
      const result = await original(request);
      if (JSON.parse(request.body).max_tokens === 1024 && ++helperCalls === 1) tab.title = "Updated search page";
      return result;
    });
    await start("fast", {}, "Search for typescript and open the result");
    await waitForAnswer("Jev verified");
    expect(helperCalls).toBe(2);
    const fills = mocks.sendTabMessage.mock.calls.filter(([, message]) => message.action?.type === "fill");
    expect(fills).toHaveLength(1);
    expect(fieldValue).toBe("typescript");
  });

  it("does not retry uncertain mutations or hand them to the LLM", async () => {
    const original = mocks.sendTabMessage.getMockImplementation()!;
    mocks.sendTabMessage.mockImplementation(async (tabId: number, message: { type: string }) => message.type === "CONTENT_EXECUTE"
      ? { ok: false, recoverable: true, message: "Mutation may have happened" } : original(tabId, message));
    await start("fast");
    await waitForAnswer("unverified action");
    expect(requests("llm")).toHaveLength(0);
    expect(mocks.sendTabMessage.mock.calls.filter(([, message]) => message.type === "CONTENT_EXECUTE")).toHaveLength(1);
  });

  it("hands a confirmed unchanged Jev action loop to the LLM with its history", async () => {
    const original = mocks.sendTabMessage.getMockImplementation()!;
    mocks.sendTabMessage.mockImplementation(async (tabId: number, message: { type: string; action?: AgentAction }) =>
      message.type === "CONTENT_EXECUTE" && message.action?.type === "click" && tab.url.endsWith("/home")
        ? { ok: true, message: "Clicked but unchanged", observation: observation() } : original(tabId, message));
    await start("fast");
    await waitForAnswer("Jev verified");
    const firstPlannerMessages = JSON.parse(requests("llm")[0].body).messages as Array<{ content: unknown }>;
    expect(firstPlannerMessages.some((message) => typeof message.content === "string" && message.content.includes("No progress after repeated click"))).toBe(true);
    expect(requests("llm")).toHaveLength(1);
    const executed = mocks.sendTabMessage.mock.calls.filter(([, message]) => message.type === "CONTENT_EXECUTE").map(([, message]) => message.action.type);
    expect(executed).toEqual(["click", "click", "navigate", "click"]);
    expect(tab.url).toBe("https://example.test/docs/setup");
  });

  it("cancels a hybrid text request before any input is executed", async () => {
    useField = true;
    const original = mocks.transport.getMockImplementation()!;
    mocks.transport.mockImplementation((request: ModelHttpRequest) => JSON.parse(request.body).max_tokens === 1024
      ? new Promise<never>((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))))
      : original(request));
    await start("fast", {}, "Search for typescript");
    await vi.waitFor(() => expect(requests("llm")).toHaveLength(1));
    await send({ type: "SIDEPANEL_STOP_TASK" });
    await vi.waitFor(async () => expect(await send({ type: "SIDEPANEL_GET_STATE" })).toMatchObject({ running: false, waitingForModel: false }));
    expect(requests("llm")[0].signal.aborted).toBe(true);
    expect(fieldValue).toBe("");
    expect(mocks.sendTabMessage.mock.calls.filter(([, message]) => message.type === "CONTENT_EXECUTE")).toHaveLength(0);
  });
});