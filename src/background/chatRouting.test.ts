import { describe, expect, it } from "vitest";
import type { AgentAction, AgentChatMessage, AgentModelResponse } from "../shared/types";
import { buildContinuationInstruction, getChatResponseTimeMs, getConsolePlanSummary, getDirectChatAnswer } from "./chatRouting";

function response(thoughtSummary: string, action: AgentAction): AgentModelResponse {
  return {
    mode: "browser",
    thought_summary: thoughtSummary,
    risk_level: "low",
    action,
  };
}

describe("chat output routing", () => {
  it("measures an assistant response from its matching user turn", () => {
    const messages: AgentChatMessage[] = [
      { id: "user-old", role: "user", kind: "message", content: "Old", timestamp: 100, runId: "run-old" },
      { id: "user-new", role: "user", kind: "message", content: "New", timestamp: 1_000, runId: "run-new" },
    ];

    expect(getChatResponseTimeMs(messages, "run-new", 4_250)).toBe(3_250);
    expect(getChatResponseTimeMs(messages, "missing", 4_250)).toBeUndefined();
  });

  it("returns a direct answer when the first model response selects chat mode", () => {
    const action: AgentAction = {
      type: "done",
      outcome: "completed",
      text: "Hello! How can I help?",
    };
    const modelResponse = { ...response("Greeting response", action), mode: "chat" as const };

    expect(getDirectChatAnswer(modelResponse, [action], true)).toBe("Hello! How can I help?");
  });

  it("does not bypass browser routing when chat mode is not allowed", () => {
    const action: AgentAction = { type: "done", outcome: "completed", text: "Finished" };
    const modelResponse = { ...response("Finished", action), mode: "chat" as const };

    expect(getDirectChatAnswer(modelResponse, [action], false)).toBeUndefined();
  });

  it.each([
    { type: "summarize_page" as const },
    { type: "summarize_pdf" as const },
    { type: "done" as const, outcome: "completed" as const, text: "Private final answer" },
    { type: "ask_user" as const, text: "Private user question" },
  ])("keeps $type response content out of Console", (action) => {
    const privateContent = "Private summary content that belongs in Chat";
    const summary = getConsolePlanSummary(response(privateContent, action), [action]);
    expect(summary).not.toContain(privateContent);
    expect(summary).toContain("Chat");
  });

  it("keeps ordinary browser-action reasoning in Console", () => {
    const action: AgentAction = { type: "click", elementId: "el-1" };
    expect(getConsolePlanSummary(response("Opening the selected result", action), [action]))
      .toBe("Opening the selected result");
  });

  it("carries the original task, question, and reply into a continuation", () => {
    const instruction = buildContinuationInstruction(
      { instruction: "Upload the report", question: "Which file should I use?" },
      "Use quarterly.pdf",
    );
    expect(instruction).toContain("Upload the report");
    expect(instruction).toContain("Which file should I use?");
    expect(instruction).toContain("Use quarterly.pdf");
  });
});