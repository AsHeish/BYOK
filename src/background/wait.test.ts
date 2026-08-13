import { describe, expect, it } from "vitest";
import { advanceDomStability } from "./wait";

describe("DOM stability", () => {
  it("requires three consecutive complete samples and resets when the DOM changes", () => {
    const first = advanceDomStability(undefined, 0, "state-a", "complete", 3);
    expect(first.matched).toBe(false);

    const second = advanceDomStability(first.signature, first.stableSamples, "state-a", "complete", 3);
    expect(second.matched).toBe(false);

    const changed = advanceDomStability(second.signature, second.stableSamples, "state-b", "complete", 3);
    expect(changed.matched).toBe(false);
    expect(changed.stableSamples).toBe(1);

    const changedSecond = advanceDomStability(changed.signature, changed.stableSamples, "state-b", "complete", 3);
    expect(changedSecond.matched).toBe(false);
    const changedThird = advanceDomStability(changedSecond.signature, changedSecond.stableSamples, "state-b", "complete", 3);
    expect(changedThird.matched).toBe(true);
  });
});
