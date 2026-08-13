import { describe, expect, it } from "vitest";
import { sanitizeMessagesForLogging, type ChatMessage } from "./modelClient";

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
