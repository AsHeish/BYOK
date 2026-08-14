// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { checkWaitCondition } from "./domMap";

describe("DOM settlement signature", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main>
        <input id="name" value="" />
        <input id="approved" type="checkbox" />
        <select id="priority">
          <option value="low">Low</option>
          <option value="high">High</option>
        </select>
        <button id="submit">Submit</button>
      </main>
    `;
  });

  it("changes when form state changes without changing text or element count", () => {
    const initialText = document.body.textContent;
    const initialElementCount = document.querySelectorAll("*").length;
    const signatures = [signature()];

    (document.querySelector("#name") as HTMLInputElement).value = "Ashish";
    signatures.push(signature());

    (document.querySelector("#approved") as HTMLInputElement).checked = true;
    signatures.push(signature());

    (document.querySelector("#priority") as HTMLSelectElement).value = "high";
    signatures.push(signature());

    (document.querySelector("#submit") as HTMLButtonElement).disabled = true;
    signatures.push(signature());

    expect(document.body.textContent).toBe(initialText);
    expect(document.querySelectorAll("*")).toHaveLength(initialElementCount);
    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it("detects state changes inside an open shadow root", () => {
    const host = document.createElement("section");
    document.body.append(host);
    const shadowRoot = host.attachShadow({ mode: "open" });
    shadowRoot.innerHTML = '<input id="shadow-input" value="" />';
    const initialTopLevelCount = document.querySelectorAll("*").length;
    const before = signature();

    (shadowRoot.querySelector("#shadow-input") as HTMLInputElement).value = "updated";
    const after = signature();

    expect(document.querySelectorAll("*")).toHaveLength(initialTopLevelCount);
    expect(after).not.toBe(before);
  });
});

function signature(): string {
  return checkWaitCondition({ condition: "dom_stable" }).signature;
}