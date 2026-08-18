import type { AgentAction, AgentChatMessage, AgentModelResponse } from "../shared/types";

export function getConsolePlanSummary(
  modelResponse: AgentModelResponse,
  actions: AgentAction[],
): string {
  const actionTypes = new Set(actions.map((action) => action.type));
  if (actionTypes.has("ask_user")) {
    return "The agent needs user input and will ask in Chat.";
  }
  if (actionTypes.has("done")) {
    return "The agent prepared a final response for Chat.";
  }
  if (actionTypes.has("summarize_page") || actionTypes.has("summarize_pdf")) {
    return "The agent is preparing a summary for Chat.";
  }
  return modelResponse.thought_summary;
}

export function getDirectChatAnswer(
  modelResponse: AgentModelResponse,
  actions: AgentAction[],
  allowChatMode: boolean,
): string | undefined {
  if (!allowChatMode || modelResponse.mode !== "chat" || actions.length !== 1 || actions[0].type !== "done") {
    return undefined;
  }

  return actions[0].text?.trim() || modelResponse.thought_summary.trim() || undefined;
}

export function getChatResponseTimeMs(
  messages: AgentChatMessage[],
  runId: string | undefined,
  responseTimestamp: number,
): number | undefined {
  if (!runId) {
    return undefined;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user" && message.runId === runId) {
      return Math.max(0, responseTimestamp - message.timestamp);
    }
  }

  return undefined;
}

export function buildContextualChatInstruction(
  messages: AgentChatMessage[],
  submittedTask: string,
): string {
  if (messages.length === 0) {
    return submittedTask;
  }

  return [
    "Use the recent conversation only as context for the latest request.",
    ...messages.map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`),
    `Latest user request: ${submittedTask}`,
  ].join("\n\n");
}

export function buildContinuationInstruction(
  continuation: { instruction: string; question: string },
  response: string,
): string {
  return [
    "Continue the browser task that paused for user input.",
    `Original task and context: ${continuation.instruction}`,
    `Agent question: ${continuation.question}`,
    `User response: ${response}`,
    "Use the response to continue the original task. Do not treat it as a separate task.",
  ].join("\n\n");
}