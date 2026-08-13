import { describe, expect, it } from "vitest";
import { isVisibleOwnedTab } from "./screenshot";

describe("screenshot ownership", () => {
  it("allows only the visible active tab when it is tracked by the session", () => {
    const trackedTabs = [11, 12];
    expect(isVisibleOwnedTab(trackedTabs, 11, 99)).toBe(false);
    expect(isVisibleOwnedTab(trackedTabs, 99, 99)).toBe(false);
    expect(isVisibleOwnedTab(trackedTabs, 11, 11)).toBe(true);
  });
});
