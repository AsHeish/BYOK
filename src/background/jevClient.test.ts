import { afterEach, describe, expect, it, vi } from "vitest";
import { JEV_MAX_ATTEMPTS, JEV_MODEL, JEV_RETRY_BACKOFF_MS, JEV_TIMEOUT_MS, requestJevDecision, requestJevQuestions, testJevConnection } from "./jevClient";
import type { ModelHttpRequest } from "./modelClient";

afterEach(() => vi.useRealTimers());

const args = () => ({
  apiKey: "test-key",
  state: { goal: "Read the setup guide" },
  criteria: { guide: "Setup guide", fallback: "Let the planner decide" },
  signal: new AbortController().signal,
});

function response(answer: unknown = {
  type: "choice", choice: "guide", confidence: 0.98, probabilities: { guide: 0.99, fallback: 0.01 },
}) {
  return {
    ok: true, status: 200, statusText: "OK",
    responseText: JSON.stringify({ model: JEV_MODEL, answers: { navigation: answer }, usage: { input_tokens: 120, output_tokens: 20 } }),
  };
}

describe("Jev decision client", () => {
  it("ignores malformed unused heads but validates the selected target", async () => {
    const questions = {
      operation: { type: "choice" as const, instructions: "Choose operation", criteria: { click: "Click", done: "Done" } },
      click_target: { type: "choice" as const, instructions: "Choose target", criteria: { button: "Answer", fallback: "None" } },
      completion: { type: "choice" as const, instructions: "Verify", criteria: { verified: "Complete", incomplete: "Incomplete" } },
    };
    const requiredQuestions = { selector: "operation", byChoice: { click: ["click_target"], done: ["completion"] } };
    const answers = {
      operation: { type: "choice", choice: "click", confidence: 1, probabilities: { click: 1, done: 0 } },
      click_target: { type: "choice", choice: "button", confidence: 1, probabilities: { button: 1, fallback: 0 } },
      completion: { type: "choice", choice: "verified", confidence: 1, probabilities: { verified: 0.9, incomplete: 0.9 } },
    };
    const transport = vi.fn().mockResolvedValue({ ...response(), responseText: JSON.stringify({ answers }) });
    const result = await requestJevQuestions({ ...args(), questions, requiredQuestions }, transport);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(result.answers.click_target.choice).toBe("button");
    expect(result.answers).not.toHaveProperty("completion");
    expect(result.ignoredAnswers).toEqual(["completion"]);
    answers.operation = { type: "choice", choice: "done", confidence: 1, probabilities: { click: 0, done: 1 } };
    transport.mockResolvedValue({ ...response(), responseText: JSON.stringify({ answers }) });
    await expect(requestJevQuestions({ ...args(), questions, requiredQuestions }, transport)).rejects.toThrow('invalid probabilities for "completion": sum=1.800000');
  });

  it("accepts and normalizes small rounding differences without changing the choice", async () => {
    const transport = vi.fn().mockResolvedValue(response({ type: "choice", choice: "guide", confidence: 0.98, probabilities: { guide: 0.98, fallback: 0.005 } }));
    const result = await requestJevDecision(args(), transport);
    expect(result.choice).toBe("guide");
    expect(result.confidence).toBe(0.98);
    expect(Object.values(result.probabilities).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
  });

  it("reports large probability errors without exposing page data", async () => {
    const transport = vi.fn().mockResolvedValue(response({ type: "choice", choice: "guide", confidence: 1, probabilities: { guide: 0.4, fallback: 0.3 } }));
    await expect(requestJevDecision(args(), transport)).rejects.toThrow('invalid probabilities for "navigation": sum=0.700000');
  });

  it("batches operation and target choices in one HTTP request", async () => {
    const questions = {
      operation: { type: "choice" as const, instructions: "Choose operation", criteria: { click: "Click", stop: "Stop" } },
      target: { type: "choice" as const, instructions: "Choose target", criteria: { button: "Search", none: "None" } },
    };
    const transport = vi.fn().mockResolvedValue({ ...response(), responseText: JSON.stringify({ answers: {
      operation: { type: "choice", choice: "click", confidence: 1, probabilities: { click: 1, stop: 0 } },
      target: { type: "choice", choice: "button", confidence: 1, probabilities: { button: 1, none: 0 } },
    } }) });
    const result = await requestJevQuestions({ ...args(), questions }, transport);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.parse(transport.mock.calls[0][0].body).questions).toEqual(questions);
    expect(result.answers.target.choice).toBe("button");
    expect(result.answers.operation.probabilities).toEqual({ click: 1, stop: 0 });
  });

  it("rejects an answer from another question's choice set", async () => {
    const questions = { operation: { type: "choice" as const, instructions: "Choose", criteria: { click: "Click", stop: "Stop" } } };
    const transport = vi.fn().mockResolvedValue({ ...response(), responseText: JSON.stringify({ answers: {
      operation: { type: "choice", choice: "el-1", confidence: 1, probabilities: { "el-1": 1, stop: 0 } },
    } }) });
    await expect(requestJevQuestions({ ...args(), questions }, transport)).rejects.toThrow("invalid");
  });

  it("tests connectivity with synthetic context only", async () => {
    const transport = vi.fn().mockResolvedValue(response());
    await expect(testJevConnection("jev-key", transport)).resolves.toMatchObject({ ok: true });
    expect(transport).toHaveBeenCalledTimes(1);
    const request = transport.mock.calls[0][0] as ModelHttpRequest;
    expect(JSON.parse(request.body).state).toEqual({ goal: "Find setup instructions", title: "Documentation index" });
  });

  it("sends typed questions through the supplied transport", async () => {
    const transport = vi.fn().mockResolvedValue(response());
    const result = await requestJevDecision(args(), transport);
    expect(result).toMatchObject({ choice: "guide", confidence: 0.98, inputTokens: 120, outputTokens: 20 });
    expect(transport).toHaveBeenCalledTimes(1);
    const request = transport.mock.calls[0][0] as ModelHttpRequest;
    expect(request.endpoint).toBe("https://api.typesafe.ai/v1/systemone");
    expect(JSON.parse(request.body)).toMatchObject({ model: JEV_MODEL, questions: { navigation: { type: "choice" } } });
    expect(request.headers.Authorization).toBe("Bearer test-key");
  });

  it.each([
    { type: "choice", choice: "invented", confidence: 1, probabilities: { guide: 1, fallback: 0 } },
    { type: "choice", choice: "guide", confidence: 2, probabilities: { guide: 1, fallback: 0 } },
    { type: "choice", choice: "guide", confidence: 1, probabilities: { guide: 0.2, fallback: 0.8 } },
    { type: "choice", choice: "guide", confidence: 1, probabilities: { guide: 1 } },
    { type: "choice", choice: "guide", confidence: 1, probabilities: { guide: 1, fallback: 1 } },
    null,
  ])("rejects invalid answers without executing anything", async (answer) => {
    await expect(requestJevDecision(args(), vi.fn().mockResolvedValue(response(answer)))).rejects.toThrow("invalid");
  });

  it.each([400, 401, 403, 500])("does not retry HTTP %s", async (status) => {
    const transport = vi.fn().mockResolvedValue({ ...response(), ok: false, status });
    await expect(requestJevDecision(args(), transport)).rejects.toMatchObject({ status });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("retries rate limits and overload, then reports the attempts and answering model", async () => {
    vi.useFakeTimers();
    const transport = vi.fn()
      .mockResolvedValueOnce({ ...response(), ok: false, status: 429 })
      .mockResolvedValueOnce({ ...response(), ok: false, status: 503 })
      .mockResolvedValueOnce(response());
    const pending = requestJevDecision(args(), transport);
    await vi.advanceTimersByTimeAsync(JEV_RETRY_BACKOFF_MS);
    expect(transport).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(JEV_RETRY_BACKOFF_MS);
    expect(transport).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(JEV_RETRY_BACKOFF_MS);
    await expect(pending).resolves.toMatchObject({ choice: "guide", attempts: 3, model: JEV_MODEL });
    expect(transport).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries HTTP 529 and stops after the attempt limit", async () => {
    vi.useFakeTimers();
    const transport = vi.fn().mockResolvedValue({ ...response(), ok: false, status: 529 });
    const pending = requestJevDecision(args(), transport);
    const rejection = expect(pending).rejects.toMatchObject({ status: 529, message: "Jev returned HTTP 529 after 3 attempts." });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(transport).toHaveBeenCalledTimes(JEV_MAX_ATTEMPTS);
  });

  it("gives each attempt its own deadline", async () => {
    vi.useFakeTimers();
    const transport = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve({ ...response(), ok: false, status: 429 }), JEV_TIMEOUT_MS - 100)))
      .mockResolvedValueOnce(response());
    const pending = requestJevDecision(args(), transport);
    await vi.advanceTimersByTimeAsync(JEV_TIMEOUT_MS - 100 + JEV_RETRY_BACKOFF_MS);
    await expect(pending).resolves.toMatchObject({ attempts: 2 });
    expect(transport.mock.calls[0][0].signal).not.toBe(transport.mock.calls[1][0].signal);
    expect(transport.mock.calls[1][0].signal.aborted).toBe(false);
  });

  it("also bounds a retried attempt by the deadline", async () => {
    vi.useFakeTimers();
    const hang = (request: ModelHttpRequest) => new Promise<never>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    });
    const transport = vi.fn()
      .mockResolvedValueOnce({ ...response(), ok: false, status: 429 })
      .mockImplementationOnce(hang);
    const rejection = expect(requestJevDecision(args(), transport)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(JEV_RETRY_BACKOFF_MS + JEV_TIMEOUT_MS);
    await rejection;
    expect(transport).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry a timeout or a transport failure", async () => {
    vi.useFakeTimers();
    const hanging = vi.fn((request: ModelHttpRequest) => new Promise<never>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const timedOut = expect(requestJevDecision(args(), hanging)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(JEV_TIMEOUT_MS);
    await timedOut;
    expect(hanging).toHaveBeenCalledTimes(1);
    const broken = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(requestJevDecision(args(), broken)).rejects.toThrow("failed or returned malformed JSON");
    expect(broken).toHaveBeenCalledTimes(1);
  });

  it("treats Stop during the retry pause as cancellation without another request", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const transport = vi.fn().mockResolvedValue({ ...response(), ok: false, status: 429 });
    const pending = requestJevDecision({ ...args(), signal: controller.signal }, transport);
    const rejection = expect(pending).rejects.toMatchObject({ name: "ModelRequestCancelledError" });
    await vi.advanceTimersByTimeAsync(JEV_RETRY_BACKOFF_MS / 2);
    expect(transport).toHaveBeenCalledTimes(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(JEV_RETRY_BACKOFF_MS * 4);
    await rejection;
    expect(transport).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends the configured model and defaults to the pinned one", async () => {
    const transport = vi.fn().mockResolvedValue(response());
    await requestJevDecision({ ...args(), model: "jev-custom-2" }, transport);
    expect(JSON.parse(transport.mock.calls[0][0].body).model).toBe("jev-custom-2");
    await requestJevDecision(args(), transport);
    expect(JSON.parse(transport.mock.calls[1][0].body).model).toBe(JEV_MODEL);
    await testJevConnection("jev-key", transport, "jev-custom-3");
    expect(JSON.parse(transport.mock.calls[2][0].body).model).toBe("jev-custom-3");
  });

  it("bounds latency and propagates its deadline to the transport", async () => {
    vi.useFakeTimers();
    const transport = vi.fn((request: ModelHttpRequest) => new Promise<never>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const pending = requestJevDecision(args(), transport);
    const rejection = expect(pending).rejects.toThrow("timed out");
    expect(transport).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(JEV_TIMEOUT_MS);
    await rejection;
    expect(transport.mock.calls[0][0].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats Stop as cancellation, not fallback", async () => {
    const controller = new AbortController();
    const transport = vi.fn((request: ModelHttpRequest) => new Promise<never>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const pending = requestJevDecision({ ...args(), signal: controller.signal }, transport);
    expect(transport).toHaveBeenCalledTimes(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "ModelRequestCancelledError" });
  });

  it("does not send an already cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = vi.fn();
    await expect(requestJevDecision({ ...args(), signal: controller.signal }, transport)).rejects.toMatchObject({ name: "ModelRequestCancelledError" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not expose raw malformed responses", async () => {
    const transport = vi.fn().mockResolvedValue({ ...response(), responseText: "private content" });
    await expect(requestJevDecision(args(), transport)).rejects.toThrow("malformed JSON");
  });
});