import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSettings } from "../shared/types";
import {
  formatModelErrorDetails,
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
    { provider: "custom", model: "gpt-5.2", apiBaseUrl: "https://gateway.example/v1", expected: { reasoning_effort: "none" } },
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
  it.each(["shadow", "off"] as const)("never sends a text request in %s mode", async (mode) => {
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

describe("OpenAI Responses API", () => {
  const OPENAI: AgentSettings = { ...SETTINGS, apiBaseUrl: "https://api.openai.com/v1", model: "gpt-5.2" };

  it("routes api.openai.com to /responses with Responses fields and parses message output", async () => {
    const transport = vi.fn().mockResolvedValue(responsesResponse(DONE_JSON, { split: true }));
    setModelRequestTransport(transport);
    const messages: ChatMessage[] = [
      { role: "system", content: "Return strict JSON only." },
      { role: "user", content: [
        { type: "text", text: "Inspect this" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,abc", detail: "low" } },
      ] },
    ];

    const result = await requestAgentStep({ ...OPENAI, promptCacheMode: "on", disableThinking: true }, messages);

    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0].endpoint).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(transport.mock.calls[0][0].body);
    expect(body).toMatchObject({
      model: "gpt-5.2",
      store: false,
      reasoning: { effort: "none" },
      text: { format: { type: "json_object" } },
      prompt_cache_key: expect.stringMatching(/^byok-agent-/),
      prompt_cache_retention: "in_memory",
      input: [
        { role: "system", content: "Return strict JSON only." },
        { role: "user", content: [
          { type: "input_text", text: "Inspect this" },
          { type: "input_image", image_url: "data:image/jpeg;base64,abc", detail: "low" },
        ] },
      ],
    });
    for (const key of ["messages", "temperature", "response_format", "reasoning_effort", "max_tokens"]) {
      expect(body).not.toHaveProperty(key);
    }
    expect(result.response.actions?.[0]).toMatchObject({ type: "done", text: "Done" });
    expect(result.usage).toMatchObject({ promptTokens: 120, cachedPromptTokens: 64, completionTokens: 30, totalTokens: 150, attempts: 1 });
  });

  it.each(["gpt-5.5", "gpt-6-astra"])("omits in_memory cache retention for %s", async (model) => {
    const transport = vi.fn().mockResolvedValue(responsesResponse(DONE_JSON));
    setModelRequestTransport(transport);
    await requestAgentStep({ ...OPENAI, model, promptCacheMode: "on" }, MESSAGES);
    const body = JSON.parse(transport.mock.calls[0][0].body);
    expect(body.prompt_cache_key).toMatch(/^byok-agent-/);
    expect(body).not.toHaveProperty("prompt_cache_retention");
    expect(body).not.toHaveProperty("temperature");
  });

  it("keeps temperature for non-reasoning models", async () => {
    const transport = vi.fn().mockResolvedValue(responsesResponse(DONE_JSON));
    setModelRequestTransport(transport);
    await requestAgentStep({ ...OPENAI, model: "gpt-4.1-mini" }, MESSAGES);
    expect(JSON.parse(transport.mock.calls[0][0].body).temperature).toBe(0.2);
  });

  it.each([
    [{ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }, "incomplete (max_output_tokens)"],
    [{ output: [{ type: "message", content: [{ type: "refusal", refusal: "Not allowed" }] }] }, "refused the request: Not allowed"],
  ])("surfaces unusable output %#", async (overrides, message) => {
    setModelRequestTransport(vi.fn().mockResolvedValue(responsesResponse(DONE_JSON, { overrides })));
    await expect(requestAgentStep(OPENAI, MESSAGES)).rejects.toThrow(message);
  });

  it("retries without text.format when the model rejects JSON mode", async () => {
    const notices: ModelRequestNotice[] = [];
    const transport = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, statusText: "Bad Request", responseText: '{"error":{"message":"Unsupported parameter: text.format"}}' })
      .mockResolvedValueOnce(responsesResponse(DONE_JSON));
    setModelRequestTransport(transport);
    const result = await requestAgentStep(OPENAI, MESSAGES, (notice) => notices.push(notice));
    expect(transport).toHaveBeenCalledTimes(2);
    expect(JSON.parse(transport.mock.calls[0][0].body)).toHaveProperty("text");
    expect(JSON.parse(transport.mock.calls[1][0].body)).not.toHaveProperty("text");
    expect(notices).toMatchObject([{ kind: "response-format-retry" }]);
    expect(result.usage.attempts).toBe(2);
  });

  it("uses Responses for connection tests and field text with max_output_tokens", async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce(responsesResponse("OK"))
      .mockResolvedValueOnce(responsesResponse('{"text":"Zurich"}'));
    setModelRequestTransport(transport);
    const settings: AgentSettings = { ...OPENAI, jev: { mode: "fast", apiKey: "jev" } };
    await expect(testModelConnection(settings)).resolves.toMatchObject({ ok: true });
    await expect(requestFieldText(settings, { field: "Origin" }, new AbortController().signal)).resolves.toMatchObject({ text: "Zurich", usage: { promptTokens: 120 } });
    expect(transport.mock.calls.map(([request]) => request.endpoint)).toEqual([
      "https://api.openai.com/v1/responses",
      "https://api.openai.com/v1/responses",
    ]);
    const helperBody = JSON.parse(transport.mock.calls[1][0].body);
    expect(helperBody.max_output_tokens).toBe(1024);
    expect(helperBody).not.toHaveProperty("max_tokens");
  });

  it("fails the connection test when a Responses call returns no output", async () => {
    setModelRequestTransport(vi.fn().mockResolvedValue(responsesResponse("OK", { overrides: { output: [] } })));
    await expect(testModelConnection(OPENAI)).rejects.toThrow("did not include any output");
  });

  it.each([
    ["https://api.openai.com/v1/chat/completions", "https://api.openai.com/v1/chat/completions", "messages"],
    ["https://gateway.example/v1/responses", "https://gateway.example/v1/responses", "input"],
  ])("respects an explicit endpoint path %s", async (apiBaseUrl, endpoint, messageKey) => {
    const transport = vi.fn().mockResolvedValue(messageKey === "input" ? responsesResponse(DONE_JSON) : await toModelHttpResponse(okResponse()));
    setModelRequestTransport(transport);
    await requestAgentStep({ ...OPENAI, apiBaseUrl }, MESSAGES);
    expect(transport.mock.calls[0][0].endpoint).toBe(endpoint);
    expect(JSON.parse(transport.mock.calls[0][0].body)).toHaveProperty(messageKey);
  });

  it.each([
    ["https://api.openai.com/v1", "chat", "https://api.openai.com/v1/chat/completions", "messages"],
    ["http://localhost:8000/v1", "responses", "http://localhost:8000/v1/responses", "input"],
    ["https://api.openai.com/v1/responses", "chat", "https://api.openai.com/v1/chat/completions", "messages"],
    ["https://proxy.example/openai/v1/chat/completions?api-version=1", "responses", "https://proxy.example/openai/v1/responses?api-version=1", "input"],
  ] as const)("uses the selected OpenAI endpoint for %s -> %s", async (apiBaseUrl, openAiApi, endpoint, messageKey) => {
    const transport = vi.fn().mockResolvedValue(messageKey === "input" ? responsesResponse(DONE_JSON) : await toModelHttpResponse(okResponse()));
    setModelRequestTransport(transport);
    const result = await requestAgentStep({ ...OPENAI, apiBaseUrl, openAiApi }, MESSAGES);
    expect(transport.mock.calls[0][0].endpoint).toBe(endpoint);
    expect(JSON.parse(transport.mock.calls[0][0].body)).toHaveProperty(messageKey);
    expect(result.response.actions?.[0]?.type).toBe("done");
  });

  it("ignores a stale OpenAI endpoint choice for other providers", async () => {
    const transport = vi.fn().mockResolvedValue(await toModelHttpResponse(okResponse()));
    setModelRequestTransport(transport);
    await requestAgentStep({ ...SETTINGS, provider: "custom", apiBaseUrl: "https://gateway.example/v1", openAiApi: "responses" }, MESSAGES);
    expect(transport.mock.calls[0][0].endpoint).toBe("https://gateway.example/v1/chat/completions");
  });

  it("drops unsupported sampling and token fields for reasoning models on Chat Completions gateways", async () => {
    const transport = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK", responseText: JSON.stringify({ choices: [{ message: { content: '{"text":"Zurich"}' } }] }) });
    setModelRequestTransport(transport);
    await requestFieldText({ ...SETTINGS, model: "openai/gpt-5-mini", jev: { mode: "fast", apiKey: "jev" } }, {}, new AbortController().signal);
    const body = JSON.parse(transport.mock.calls[0][0].body);
    expect(transport.mock.calls[0][0].endpoint).toBe("https://api.example.test/v1/chat/completions");
    expect(body.max_completion_tokens).toBe(1024);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("temperature");
  });
});

describe("model output diagnostics", () => {
  function chatResponse(choice: Record<string, unknown>) {
    return { ok: true, status: 200, statusText: "OK", responseText: JSON.stringify({ choices: [choice] }) };
  }

  it("reports the parse error, finish reason and raw content for non-JSON output", async () => {
    const content = "I will click the Continue button next.";
    setModelRequestTransport(vi.fn().mockResolvedValue(chatResponse({ finish_reason: "stop", message: { content } })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const outcome = await captureOutcome(requestAgentStep(SETTINGS, MESSAGES));
    const error = outcome.error as ModelClientError;
    expect(error).toBeInstanceOf(ModelClientError);
    expect(error.message).toMatch(/^The model did not return strict JSON \(.*not valid JSON.*\)\.$/);
    expect(error.debug).toMatchObject({ api: "chat", status: 200, finishReason: "stop", source: "content", rawOutput: content });
    expect(error.debug?.parseError).toBeTruthy();
    const details = formatModelErrorDetails(error)!;
    expect(details).toContain(`Parse error: ${error.debug?.parseError}`);
    expect(details).toContain("finish_reason=stop");
    expect(details).toContain(content);
    expect(warn).toHaveBeenCalledWith("[BYOK Agent] Model output was not strict JSON.", expect.objectContaining({ rawContent: content }));
  });

  it.each([
    {
      name: "a stray brace line and a repeated object",
      content: '{"mode":"browser","thought_summary":"First plan {kept}","risk_level":"low","actions":[{"type":"fill","elementId":"el-31","text":"4"},{"type":"scroll","direction":"down"}]} \n} \n{"mode":"browser","thought_summary":"Repeated plan","risk_level":"low","actions":[{"type":"fill","elementId":"el-31","text":"4"},{"type":"scroll","direction":"down"}]}',
      expected: [{ type: "fill", elementId: "el-31", text: "4" }, { type: "scroll", direction: "down" }],
    },
    {
      name: "a doubled closing brace and a repeated object",
      content: '{"mode":"browser","thought_summary":"First plan","risk_level":"low","actions":[{"type":"fill","elementId":"el-35","text":"1"},{"type":"fill","elementId":"el-36","text":"\\"}"}]}}\n{"mode":"browser","thought_summary":"Repeated plan","risk_level":"low","actions":[{"type":"fill","elementId":"el-35","text":"1"},{"type":"fill","elementId":"el-36","text":"\\"}"}]}',
      expected: [{ type: "fill", elementId: "el-35", text: "1" }, { type: "fill", elementId: "el-36", text: '"}' }],
    },
  ])("uses the first copy when the model appends $name", async ({ content, expected }) => {
    setModelRequestTransport(vi.fn().mockResolvedValue(responsesResponse(content)));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await requestAgentStep({ ...SETTINGS, openAiApi: "responses" }, MESSAGES);
    expect(() => JSON.parse(content)).toThrow();
    expect(result.response.thought_summary).toMatch(/^First plan/);
    expect(result.response.actions).toMatchObject(expected);
    expect(result.response.actions).toHaveLength(expected.length);
    expect(warn).toHaveBeenCalledWith(
      "[BYOK Agent] Model repeated the same JSON action plan; using the first copy.",
      expect.objectContaining({ finishReason: "completed", planRanges: [expect.any(String), expect.any(String)], ignoredContent: expect.stringContaining("Repeated plan") }),
    );
  });

  it("executes nothing when the model contradicts itself after a leaked end-of-turn token", async () => {
    const first = '{"mode":"browser","thought_summary":"Continue the visible quiz","risk_level":"low","requirementUpdates":[{"requirementId":"req-1","status":"pending","expectedItemCount":null}],"actions":[{"type":"fill","elementId":"el-35","text":"1"},{"type":"fill","elementId":"el-40","text":"3"},{"type":"fill","elementId":"el-52","text":"1,5"}]}';
    const second = '{"mode":"browser","thought_summary":"Answer the visible question using its actual input control","risk_level":"low","action":{"type":"fill","elementId":"el-35","text":"3"}}';
    const content = `${first}} \n</|im_end|> \nOops must current controls IDs mapping only currently seen IDs ... perhaps stale/unknown. Do one action.${second}`;
    setModelRequestTransport(vi.fn().mockResolvedValue(responsesResponse(content)));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const outcome = await captureOutcome(requestAgentStep({ ...SETTINGS, openAiApi: "responses" }, MESSAGES));
    const error = outcome.error as ModelClientError;
    expect(outcome.value).toBeUndefined();
    expect(error).toBeInstanceOf(ModelClientError);
    expect(error.message).toBe("The model returned 2 conflicting JSON action plans in one response, so none were executed. Return exactly one JSON object.");
    expect(error.debug).toMatchObject({ templateToken: "</|im_end|>", finishReason: "completed", rawOutput: content });
    expect(formatModelErrorDetails(error)).toContain("Leaked chat-template token </|im_end|>: the inference server kept generating past the end of the model turn");
    expect(warn).toHaveBeenCalledWith("[BYOK Agent] Model returned conflicting JSON action plans; none were executed.", expect.objectContaining({ planRanges: [expect.any(String), expect.any(String)] }));
  });

  it("reads a fenced top-level actionType reply as one action", async () => {
    const content = '```json\n{\n  "actionType": "ask_user",\n  "text": "Cannot confirm task completion."\n}\n```';
    setModelRequestTransport(vi.fn().mockResolvedValue(chatResponse({ finish_reason: "stop", message: { content } })));
    const result = await requestAgentStep(SETTINGS, MESSAGES);
    expect(result.response.actions).toEqual([expect.objectContaining({ type: "ask_user", text: "Cannot confirm task completion." })]);
  });

  it.each([
    { finish_reason: "length", content: '{"mode":"browser","thought_summary":"Fill","actions":[{"type":"fill","elementId":"el-1","text":"1"},{"type":"fi' },
    { finish_reason: "stop", content: '{"mode":"browser","thought_summary":"Fill","actions":[{"type":"fill","elementId":"el-1","text":"1"},]}' },
  ])("never runs a nested action from a broken reply (finish_reason=$finish_reason)", async ({ finish_reason, content }) => {
    setModelRequestTransport(vi.fn().mockResolvedValue(chatResponse({ finish_reason, message: { content } })));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const outcome = await captureOutcome(requestAgentStep(SETTINGS, MESSAGES));
    expect(outcome.value).toBeUndefined();
    expect((outcome.error as ModelClientError).message).toMatch(/^The model did not return strict JSON/);
  });

  it("names the token limit when truncated JSON stops at finish_reason=length", async () => {
    const content = '{"mode":"browser","thought_summary":"Answer question 3","action":{"type":"click","elementId":"el-';
    setModelRequestTransport(vi.fn().mockResolvedValue(chatResponse({ finish_reason: "length", message: { content } })));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const outcome = await captureOutcome(requestAgentStep(SETTINGS, MESSAGES));
    const error = outcome.error as ModelClientError;
    expect(error.message).toContain("output stopped at the token limit, finish_reason=length");
    expect(error.debug?.rawOutput).toBe(content);
  });

  it("keeps the raw HTTP body when the provider returns no message content", async () => {
    const response = chatResponse({ finish_reason: "length", message: { content: "", reasoning_content: "Thinking about el-4" } });
    setModelRequestTransport(vi.fn().mockResolvedValue(response));
    const outcome = await captureOutcome(requestAgentStep(SETTINGS, MESSAGES));
    const error = outcome.error as ModelClientError;
    expect(error.message).toBe("The model response did not include content.");
    expect(error.debug).toMatchObject({ source: "http-body", finishReason: "length", rawOutput: response.responseText });
    expect(formatModelErrorDetails(error)).toContain("Thinking about el-4");
  });

  it("keeps both ends of long output in log details", async () => {
    const content = `START${"x".repeat(10_000)}END`;
    setModelRequestTransport(vi.fn().mockResolvedValue(chatResponse({ finish_reason: "stop", message: { content } })));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const outcome = await captureOutcome(requestAgentStep(SETTINGS, MESSAGES));
    const details = formatModelErrorDetails(outcome.error)!;
    expect(details.startsWith("Parse error:")).toBe(true);
    expect(details).toContain("START");
    expect(details).toContain("END");
    expect(details).toContain("chars omitted");
    expect(details.length).toBeLessThan(4_500);
    expect(formatModelErrorDetails(new ModelClientError("No debug"))).toBeUndefined();
  });
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

const DONE_JSON = JSON.stringify({
  mode: "browser",
  thought_summary: "Finished",
  risk_level: "low",
  action: { type: "done", outcome: "completed", text: "Done" },
});

function responsesResponse(text: string, options: { split?: boolean; overrides?: Record<string, unknown> } = {}) {
  const content = options.split
    ? [{ type: "output_text", text: text.slice(0, 20), annotations: [] }, { type: "output_text", text: text.slice(20), annotations: [] }]
    : [{ type: "output_text", text, annotations: [] }];
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    responseText: JSON.stringify({
      object: "response",
      status: "completed",
      output: [
        { type: "reasoning", id: "rs_1", summary: [] },
        { type: "message", role: "assistant", status: "completed", content },
      ],
      usage: {
        input_tokens: 120,
        input_tokens_details: { cached_tokens: 64, cache_write_tokens: 0 },
        output_tokens: 30,
        output_tokens_details: { reasoning_tokens: 12 },
        total_tokens: 150,
      },
      ...options.overrides,
    }),
  };
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
