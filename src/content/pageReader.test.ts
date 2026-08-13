// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { readFullPageDocument } from "./pageReader";

describe("full-page Readability extraction", () => {
  beforeEach(() => {
    document.title = "Release Notes";
    document.body.innerHTML = `
      <main>
        <article>
          <h1>Release Notes</h1>
          <p>This release introduces durable browser run reports, requirement tracking, and safer completion checks for long automation tasks.</p>
          <input id="secret" value="ATTRIBUTE-SECRET" aria-label="Private token" />
          <p>Additional details near the end of the document remain available even when they would be below the initial browser viewport.</p>
        </article>
      </main>
    `;
    (document.querySelector("#secret") as HTMLInputElement).value = "LIVE-FORM-SECRET";
  });

  it("reads the complete article while excluding form values", () => {
    const result = readFullPageDocument();
    expect(result.title).toBe("Release Notes");
    expect(result.markdown).toContain("Additional details near the end");
    expect(result.markdown).not.toContain("ATTRIBUTE-SECRET");
    expect(result.markdown).not.toContain("LIVE-FORM-SECRET");
    expect(result.sourceCharacters).toBeGreaterThan(100);
  });
});
