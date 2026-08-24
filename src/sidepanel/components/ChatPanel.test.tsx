import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelRetryIndicator } from "./ChatPanel";

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