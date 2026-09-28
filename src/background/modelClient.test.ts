import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSettings } from "../shared/types";
import {
  ModelClientError,
  ModelRequestCancelledError,
  requestAgentStep,
  requestFieldText,
  sanitizeMessagesForLogging,
  setModelRequestTransport,
  testModelConnection,
  type ChatMessage,
  type ModelRequestNotice,
} from "./modelClient";

const SETTINGS: AgentSettings = {
  provider: "openai",
  apiBaseUrl: "https://api.example.test/v1",
  apiKey: "test-key",
  model: "test-model",
  maxSteps: 10,
  requestTimeoutSeconds: 10,
  promptCacheMode: "off",
  saveRunHistory: true,
  theme: "dark",
};

const MESSAGES: ChatMessage[] = [{ role: "user", content: "Do the next step" }];

describe("disabled model thinking", () => {
  it.each([
    { provider: "custom", model: "gemma-4-31b", apiBaseUrl: "https://local-model.example/v1", expected: { chat_template_kwargs: { enable_thinking: false } } },
    { provider: "openai", model: "Qwen/Qwen3-32B", apiBaseUrl: "http://localhost:8000/v1", expected: { chat_template_kwargs: { enable_thinking: false } } },
    { provider: "custom", model: "qwen-3.6-27b", apiBaseUrl: "https://local-model.example/v1", expected: { chat_template_kwargs: { enable_thinking: false } } },
    { provider: "openai", model: "gpt-5.2", apiBaseUrl: "https://api.openai.com/v1", expected: { reasoning_effort: "none" } },
    { provider: "gemini", model: "gemini-2.5-flash", apiBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", expected: { reasoning_effort: "none" } },
    { provider: "groq", model: "qwen/qwen3-32b", apiBaseUrl: "https://api.groq.com/openai/v1", expected: { reasoning_effort: "none" } },
    { provider: "custom", model: "google/gemma-4-31b-it", apiBaseUrl: "https://openrouter.ai/api/v1", expected: { reasoning: { enabled: false } } },
  ] as const)("sends the appropriate parameter for $model at $apiBaseUrl", async (scenario) => {
    const transport = vi.fn().mockResolvedValue(await toModelHttpResponse(okResponse()));
    setModelRequestTransport(transport);
    await requestAgentStep({ ...SETTINGS, ...scenario, disableThinking: true }, MESSAGES);
    expect(transport).toHaveBeenCalledTimes(1);
    const body = JSON.parse(transport.mock.calls[0][0].body);
    expect(body).toMatchObject(scenario.expected);
    expect(Object.keys(body).filter((key) => ["reasoning_effort", "reasoning", "chat_template_kwargs"].includes(key))).toHaveLength(1);
    expect(body.messages).toEqual(MESSAGES);
  });

  it.each([undefined, false])("leaves provider defaults untouched when disableThinking=%s", async (disableThinking) => {
    const transport = vi.fn().mockResolvedValue(await toModelHttpResponse(okResponse()));
    setModelRequestTransport(transport);
    await requestAgentStep({ ...SETTINGS, disableThinking }, MESSAGES);
    const body = JSON.parse(transport.mock.calls[0][0].body);
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("reasoning");
    expect(body).not.toHaveProperty("chat_template_kwargs");
  });

  it("does not silently enable thinking after a provider rejects the option", async () => {
    const transport = vi.fn().mockResolvedValue({ ok: false, status: 400, statusText: "Bad Request", responseText: '{"error":{"message":"Unsupported value for reasoning_effort: none"}}' });
    setModelRequestTransport(transport);
    await expect(requestAgentStep({ ...SETTINGS, disableThinking: true }, MESSAGES)).rejects.toThrow("reasoning_effort");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.parse(transport.mock.calls[0][0].body).reasoning_effort).toBe("none");
  });

  it("retains disabled thinking during JSON-format compatibility retries", async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, statusText: "Bad Request", responseText: '{"error":{"message":"Unsupported parameter: response_format"}}' })
      .mockResolvedValueOnce(await toModelHttpResponse(okResponse()));
    setModelRequestTransport(transport);
    await requestAgentStep({ ...SETTINGS, disableThinking: true }, MESSAGES);
    expect(transport).toHaveBeenCalledTimes(2);
    for (const [request] of transport.mock.calls) expect(JSON.parse(request.body).reasoning_effort).toBe("none");
  });

  it("applies the same option to connection tests and hybrid field text", async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce(await toModelHttpResponse(okResponse()))
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK", responseText: JSON.stringify({ choices: [{ message: { content: '{"text":"Zurich"}' } }], usage: { prompt_tokens: 10, completion_tokens: 4 } }) });
    setModelRequestTransport(transport);
    const settings: AgentSettings = { ...SETTINGS, provider: "custom", model: "gemma-4-31b", disableThinking: true, jev: { mode: "fast", apiKey: "jev-key" } };
    await testModelConnection(settings);
    await expect(requestFieldText(settings, { field: "Origin" }, new AbortController().signal)).resolves.toMatchObject({ text: "Zurich" });
    expect(transport).toHaveBeenCalledTimes(2);
    for (const [request] of transport.mock.calls) expect(JSON.parse(request.body).chat_template_kwargs).toEqual({ enable_thinking: false });
  });
});

describe("hybrid field text helper", () => {
  it.each(["only", "shadow", "off"] as const)("never sends a text request in %s mode", async (mode) => {
    const transport = vi.fn();
    setModelRequestTransport(transport);
    await expect(requestFieldText({ ...SETTINGS, jev: { mode, apiKey: "jev" } }, {}, new AbortController().signal)).rejects.toThrow("explicit Jev hybrid");
    expect(transport).not.toHaveBeenCalled();
  });

  it("returns only validated text and accounts for its own usage", async () => {
    const transport = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK", responseText: JSON.stringify({ choices: [{ message: { content: '{"text":"Zurich"}' } }], usage: { prompt_tokens: 10, completion_tokens: 4 } }) });
    setModelRequestTransport(transport);
    const result = await requestFieldText({ ...SETTINGS, jev: { mode: "fast", apiKey: "jev" } }, { field: "Origin" }, new AbortController().signal);
    expect(result).toMatchObject({ text: "Zurich", usage: { promptTokens: 10, completionTokens: 4, attempts: 1 } });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.parse(transport.mock.calls[0][0].body).max_tokens).toBe(1024);
  });

  it.each(['{"text":null}', '{"text":"value","action":"click"}', '```json\n{"text":"value"}\n```', '{"text":""}'])("rejects unsafe helper output %s", async (content) => {
    setModelRequestTransport(vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK", responseText: JSON.stringify({ choices: [{ message: { content } }] }) }));
    await expect(requestFieldText({ ...SETTINGS, jev: { mode: "fast", apiKey: "jev" } }, {}, new AbortController().signal)).rejects.toThrow("Nothing was typed");
  });
});

afterEach(() => {
  setModelRequestTransport(undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("multimodal prompt logging", () => {
  it("redacts image bytes without mutating the outbound message", () => {
    const messages: ChatMessage[] = [{
      role: "user",
      content: [
        { type: "text", text: "Inspect this screenshot" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,secretbase64", detail: "low" } },
      ],
    }];

    const sanitized = sanitizeMessagesForLogging(messages);
    const loggedJson = JSON.stringify(sanitized);
    expect(loggedJson).not.toContain("secretbase64");
    expect(loggedJson).toContain("[image redacted]");
    expect(JSON.stringify(messages)).toContain("secretbase64");
  });
});

describe("model request retries", () => {
  it.each(["PageUp", "page up", "PageDown", "pgdn"])("preserves the intended page-navigation key %s", async (key) => {
    setModelRequestTransport(vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK", responseText: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      mode: "browser", thought_summary: "Scroll to the previous questions", risk_level: "low", action: { type: "press_key", key },
    }) } }] }) }));
    const result = await requestAgentStep(SETTINGS, MESSAGES);
    expect(result.response.actions?.[0].key).toBe(key.toLowerCase().includes("up") ? "PageUp" : "PageDown");
  });

  it.each([undefined, "UnrecognizedKey"])("does not silently turn key %s into Tab", async (key) => {
    setModelRequestTransport(vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK", responseText: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      mode: "browser", thought_summary: "Move", risk_level: "low", action: { type: "press_key", key },
    }) } }] }) }));
    await expect(requestAgentStep(SETTINGS, MESSAGES)).rejects.toThrow("unsupported or missing key");
  });

  it("blocks Jev Only at the LLM transport boundary for steps and connection probes", async () => {
    const transport = vi.fn();
    const fetchMock = vi.fn();
    setModelRequestTransport(transport);
    vi.stubGlobal("fetch", fetchMock);
    const settings: AgentSettings = { ...SETTINGS, jev: { mode: "only", apiKey: "jev-key" } };
    await expect(requestAgentStep(settings, MESSAGES)).rejects.toThrow("LLM requests are disabled");
    await expect(testModelConnection(settings)).rejects.toThrow("LLM requests are disabled");
    expect(transport).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["Find the setup guide", "x".repeat(501)])("normalizes optional navigation delegation", async (navigationGoal) => {
    setModelRequestTransport(vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: "OK",
      responseText: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        mode: "browser", thought_summary: "Browse docs", risk_level: "low", navigationGoal,
        action: { type: "navigate", url: "https://example.test/docs/start" },
      }) } }] }),
    }));
    const result = await requestAgentStep(SETTINGS, MESSAGES);
    expect(result.response.navigationGoal).toBe(navigationGoal.length <= 500 ? navigationGoal : undefined);
  });

  it("aborts an in-flight request without retrying", async () => {
    const notices: ModelRequestNotice[] = [];
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string, init: RequestInit) => rejectWhenAborted(init.signal));
    vi.stubGlobal("fetch", fetchMock);

    const outcomePromise = captureOutcome(
      requestAgentStep(SETTINGS, MESSAGES, (notice) => notices.push(notice), controller.signal),
    );
    controller.abort();
    const outcome = await outcomePromise;

    expect(outcome.error).toBeInstanceOf(ModelRequestCancelledError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([]);
  });

  it("preserves chat mode from the model response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse("chat")));

    const result = await requestAgentStep(SETTINGS, MESSAGES, () => undefined);

    expect(result.response.mode).toBe("chat");
  });

  it("retries a timed-out request and reports the successful attempt count", async () => {
    vi.useFakeTimers();
    const notices: ModelRequestNotice[] = [];
    const fetchMock = vi.fn()
      .mockImplementationOnce((_url: string, init: RequestInit) => rejectWhenAborted(init.signal))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = requestAgentStep(SETTINGS, MESSAGES, (notice) => notices.push(notice));
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await resultPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(notices).toMatchObject([{ kind: "timeout-retry", attempt: 1, maxAttempts: 4 }]);
    expect(result.usage.attempts).toBe(2);
    expect(result.response.actions?.[0]?.type).toBe("done");
  });

  it("keeps a configured 60-second timeout with an external transport", async () => {
    vi.useFakeTimers();
    const notices: ModelRequestNotice[] = [];
    const transport = vi.fn()
      .mockImplementationOnce(({ signal }: { signal: AbortSignal }) => rejectWhenAborted(signal))
      .mockResolvedValueOnce(await toModelHttpResponse(okResponse()));
    setModelRequestTransport(transport);

    const resultPromise = requestAgentStep(
      { ...SETTINGS, requestTimeoutSeconds: 60 },
      MESSAGES,
      (notice) => notices.push(notice),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([]);

    await vi.advanceTimersByTimeAsync(30_000);
    const result = await resultPromise;

    expect(transport).toHaveBeenCalledTimes(2);
    expect(notices).toMatchObject([{
      kind: "timeout-retry",
      attempt: 1,
      message: expect.stringContaining("within 60s"),
    }]);
    expect(result.usage.attempts).toBe(2);
  });

  it("fails with usage after all timeout attempts are exhausted", async () => {
    vi.useFakeTimers();
    const notices: ModelRequestNotice[] = [];
    const fetchMock = vi.fn((_url: string, init: RequestInit) => rejectWhenAborted(init.signal));
    vi.stubGlobal("fetch", fetchMock);

    const outcomePromise = captureOutcome(requestAgentStep(SETTINGS, MESSAGES, (notice) => notices.push(notice)));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
    }
    const outcome = await outcomePromise;

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(notices).toHaveLength(3);
    expect(notices.every((notice) => notice.kind === "timeout-retry")).toBe(true);
    expect(outcome.error).toMatchObject({
      name: "ModelClientError",
      usage: { attempts: 4, status: "timeout", ok: false },
    });
  });

  it("retries without response_format when that field is rejected", async () => {
    const notices: ModelRequestNotice[] = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errorResponse(400, "Unsupported parameter: response_format"))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await requestAgentStep(SETTINGS, MESSAGES, (notice) => notices.push(notice));
    const bodies = requestBodies(fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies[0]).toHaveProperty("response_format");
    expect(bodies[1]).not.toHaveProperty("response_format");
    expect(notices).toMatchObject([{ kind: "response-format-retry", attempt: 1 }]);
    expect(result.usage.attempts).toBe(2);
  });

  it("retries without prompt cache fields when those fields are rejected", async () => {
    const notices: ModelRequestNotice[] = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errorResponse(422, "Unknown field: prompt_cache_key"))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await requestAgentStep(
      { ...SETTINGS, promptCacheMode: "on" },
      MESSAGES,
      (notice) => notices.push(notice),
    );
    const bodies = requestBodies(fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies[0]).toHaveProperty("prompt_cache_key");
    expect(bodies[0]).toHaveProperty("prompt_cache_retention");
    expect(bodies[1]).not.toHaveProperty("prompt_cache_key");
    expect(bodies[1]).not.toHaveProperty("prompt_cache_retention");
    expect(bodies[1]).toHaveProperty("response_format");
    expect(notices).toMatchObject([{ kind: "prompt-cache-retry", attempt: 1 }]);
    expect(result.usage.attempts).toBe(2);
  });

  it("applies both provider compatibility fallbacks when required", async () => {
    const notices: ModelRequestNotice[] = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errorResponse(400, "Unsupported parameter: prompt_cache_key"))
      .mockResolvedValueOnce(errorResponse(400, "Unsupported parameter: response_format"))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await requestAgentStep(
      { ...SETTINGS, promptCacheMode: "on" },
      MESSAGES,
      (notice) => notices.push(notice),
    );
    const bodies = requestBodies(fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(bodies[0]).toHaveProperty("prompt_cache_key");
    expect(bodies[0]).toHaveProperty("response_format");
    expect(bodies[1]).not.toHaveProperty("prompt_cache_key");
    expect(bodies[1]).toHaveProperty("response_format");
    expect(bodies[2]).not.toHaveProperty("prompt_cache_key");
    expect(bodies[2]).not.toHaveProperty("response_format");
    expect(notices.map((notice) => notice.kind)).toEqual([
      "prompt-cache-retry",
      "response-format-retry",
    ]);
    expect(result.usage.attempts).toBe(3);
  });

  it("does not misclassify an unrelated unknown field as response_format rejection", async () => {
    const notices: ModelRequestNotice[] = [];
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(errorResponse(400, "Unknown field: temperature")));
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestAgentStep(SETTINGS, MESSAGES, (notice) => notices.push(notice)))
      .rejects.toMatchObject({ name: "ModelClientError", status: 400 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([]);
  });

  it("does not retry a non-recoverable authentication failure", async () => {
    const notices: ModelRequestNotice[] = [];
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(401, "Invalid API key"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestAgentStep(SETTINGS, MESSAGES, (notice) => notices.push(notice)))
      .rejects.toMatchObject({ name: "ModelClientError", status: 401, usage: { attempts: 1 } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([]);
  });

  it("executes a promised compatibility fallback after earlier timeouts", async () => {
    vi.useFakeTimers();
    const notices: ModelRequestNotice[] = [];
    const fetchMock = vi.fn()
      .mockImplementationOnce((_url: string, init: RequestInit) => rejectWhenAborted(init.signal))
      .mockImplementationOnce((_url: string, init: RequestInit) => rejectWhenAborted(init.signal))
      .mockImplementationOnce((_url: string, init: RequestInit) => rejectWhenAborted(init.signal))
      .mockResolvedValueOnce(errorResponse(400, "Unsupported parameter: response_format"))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const outcomePromise = captureOutcome(requestAgentStep(SETTINGS, MESSAGES, (notice) => notices.push(notice)));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
    }
    const outcome = await outcomePromise;
    const bodies = requestBodies(fetchMock);

    expect(outcome.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(bodies[3]).toHaveProperty("response_format");
    expect(bodies[4]).not.toHaveProperty("response_format");
    expect(notices.at(-1)?.kind).toBe("response-format-retry");
    expect(outcome.value?.usage.attempts).toBe(5);
  });
});

describe("model connection test", () => {
  it("checks the configured model without requesting agent JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await testModelConnection(SETTINGS);
    const body = requestBodies(fetchMock)[0];

    expect(result).toMatchObject({ ok: true });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(body).not.toHaveProperty("response_format");
    expect(body).toMatchObject({ model: "test-model" });
  });

  it("surfaces provider authentication failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errorResponse(401, "Invalid API key")));

    await expect(testModelConnection(SETTINGS)).rejects.toMatchObject({
      name: "ModelClientError",
      status: 401,
    });
  });
});

function rejectWhenAborted(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => {
      reject(new DOMException("The operation was aborted.", "AbortError"));
    });
  });
}

function okResponse(mode: "chat" | "browser" = "browser"): Response {
  return new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({
          mode,
          thought_summary: "Finished",
          risk_level: "low",
          action: { type: "done", outcome: "completed", text: "Done" },
        }),
      },
    }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function toModelHttpResponse(response: Response) {
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    responseText: await response.text(),
  };
}

function requestBodies(fetchMock: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

function captureOutcome<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}
