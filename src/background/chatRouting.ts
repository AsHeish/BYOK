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