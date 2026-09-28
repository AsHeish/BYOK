import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { JevSettings } from "../../shared/types";
import { ChatPanel, ModelRetryIndicator } from "./ChatPanel";

function renderChat(jevMode?: JevSettings["mode"], hasJevKey = true, disabled = false) {
  return renderToStaticMarkup(<ChatPanel
    messages={[]}
    running={false}
    waitingForModel={false}
    disabled={disabled}
    model="planner-model"
    jevMode={jevMode}
    hasJevKey={hasJevKey}
    onSend={async () => undefined}
    onRerun={async () => undefined}
    onStop={async () => undefined}
    onClear={async () => undefined}
  />);
}

describe("Jev chat capabilities", () => {
  it("identifies Jev Only without advertising an LLM or unsupported starters", () => {
    const markup = renderChat("only");
    expect(markup).toContain("Jev Only");
    expect(markup).toContain("No LLM is used.");
    expect(markup).toContain("Jev:");
    expect(markup).not.toContain("LLM:");
    expect(markup).not.toContain("planner-model");
    expect(markup).not.toContain("Summarize the current page.");
    expect(markup).not.toContain("request a summary");
    expect(markup).toContain("What should I do in the browser?");
    expect(markup).toContain("exact double-quoted values");
    expect(markup).not.toContain("Jev cannot run alone");
  });

  it("requires only the TypeSafe key and promises no silent fallback", () => {
    const markup = renderChat("only", false, true);
    expect(markup).toContain("Add a TypeSafe API key in Settings for Jev Only.");
    expect(markup).toContain("Jev Only will not fall back to an LLM.");
    expect(markup).not.toContain("Add an LLM API key");
  });

  it.each([undefined, "off"] as const)("omits the notice when Jev is %s", (mode) => {
    const markup = renderChat(mode);
    expect(markup).not.toContain('aria-label="Jev capabilities"');
    expect(markup).toContain("Model:");
  });

  it("explains the limited fast path while still identifying the LLM", () => {
    const markup = renderChat("fast");
    expect(markup).toContain('aria-label="Jev capabilities"');
    expect(markup).toContain("Jev Fast + LLM");
    expect(markup).toContain("Jev chooses browser actions");
    expect(markup).toContain("supplies missing field text");
    expect(markup).toContain("LLM:");
    expect(markup).toContain("planner-model");
  });

  it("does not describe shadow decisions as executed actions", () => {
    const markup = renderChat("shadow");
    expect(markup).toContain("Jev Shadow + LLM");
    expect(markup).toContain("records action choices only");
    expect(markup).toContain("LLM still performs all tasks");
  });

  it("does not imply Jev is running before its key is configured", () => {
    expect(renderChat("fast", false)).toContain("Jev needs a TypeSafe API key in Settings. Until then, only the LLM runs.");
  });

  it("explains why an LLM key is required even with a Jev key", () => {
    expect(renderChat("fast", true, true)).toContain("Add an LLM API key in Settings. Jev cannot run alone.");
  });
});

describe("model retry indicator", () => {
  it("tells the user that a timeout is being retried", () => {
    const markup = renderToStaticMarkup(
      <ModelRetryIndicator
        status={{
          message: "The model did not respond within 60s on attempt 1 of 4. Retrying the same step now.",
          attempt: 1,
          maxAttempts: 4,
        }}
      />,
    );

    expect(markup).toContain("Model timed out. Retrying request...");
    expect(markup).toContain("The model did not respond within 60s");
    expect(markup).toContain("2/4");
    expect(markup).toContain('role="status"');
  });
});