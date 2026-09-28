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
  it("distinguishes page scrolling from focus changes and forbids guessed form IDs", () => {
    const messages = buildAgentMessages({ task: "Fill remaining problems", observation: OBSERVATION, step: 3, maxSteps: 10 });
    const system = getTextContent(messages[0].content);
    expect(system).toContain("Tab, Shift+Tab, PageUp, or PageDown");
    expect(system).toContain("Never guess a field ID");
    expect(system).toContain("read_page does not scroll");
    expect(system).toContain("does not press Tab or advance focus");
  });

  it("offers one-step navigation delegation only when Jev is configured", () => {
    const args = { task: "Find the guide", observation: OBSERVATION, step: 1, maxSteps: 10 };
    const disabled = buildAgentMessages(args);
    const enabled = buildAgentMessages({ ...args, allowJevNavigation: true });
    expect(getTextContent(disabled[2].content)).not.toContain("navigationGoal");
    expect(getTextContent(enabled[2].content)).toContain("navigationGoal");
    expect(getTextContent(enabled[2].content)).toContain("one same-origin public-content link");
    expect(enabled[0]).toEqual(disabled[0]);
  });

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