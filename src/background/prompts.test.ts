import { describe, expect, it } from "vitest";
import type { PageObservation } from "../shared/types";
import { buildAgentMessages } from "./prompts";

const OBSERVATION: PageObservation = {
  url: "https://example.test/dashboard",
  title: "Example dashboard",
  text: "Dashboard page content",
  elements: [],
};

describe("agent response mode prompt", () => {
  it("lets the first call choose a mode while including browser context", () => {
    const messages = buildAgentMessages({
      task: "hello",
      observation: OBSERVATION,
      step: 1,
      maxSteps: 10,
      allowChatMode: true,
    });

    expect(getTextContent(messages[0].content)).toContain("Use mode=chat for greetings");
    expect(getTextContent(messages[1].content)).toContain("hello");
    expect(getTextContent(messages[2].content)).toContain("Dashboard page content");
  });

  it("forces browser mode after routing or for a continuation", () => {
    const firstMessages = buildAgentMessages({
      task: "Start a task",
      observation: OBSERVATION,
      step: 1,
      maxSteps: 10,
      allowChatMode: true,
    });
    const laterMessages = buildAgentMessages({
      task: "Continue the browser task",
      observation: OBSERVATION,
      step: 2,
      maxSteps: 10,
      allowChatMode: false,
    });

    expect(getTextContent(laterMessages[2].content)).toContain("browser only. Set mode=browser");
    expect(getTextContent(laterMessages[0].content)).toBe(getTextContent(firstMessages[0].content));
  });
});

function getTextContent(content: (typeof buildAgentMessages extends (...args: never[]) => Array<infer Message> ? Message : never)["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content.map((part) => part.type === "text" ? part.text : "").join("\n");
}