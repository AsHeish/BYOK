import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSettings } from "../shared/types";
import {
  ModelClientError,
  ModelRequestCancelledError,
  requestAgentStep,
  sanitizeMessagesForLogging,
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

afterEach(() => {
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

function requestBodies(fetchMock: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
}

function captureOutcome<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}
