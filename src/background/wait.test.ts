import { describe, expect, it } from "vitest";
import type { AgentAction } from "../shared/types";
import {
  advanceDomStability,
  needsAutomaticDomSettlement,
  waitForDomSettlement,
} from "./wait";

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

  it("waits through the minimum observation window before reporting stability", async () => {
    const events: string[] = [];
    const result = await waitForDomSettlement(
      async () => {
        events.push("sample");
        return { signature: "stable", readyState: "complete" };
      },
      async () => {
        events.push("pause");
      },
      () => false,
      { minimumSamples: 4, requiredStableSamples: 3, maximumSamples: 8 },
    );
    events.push("next-llm-call");

    expect(result).toEqual({ settled: true, cancelled: false, sampleCount: 4 });
    expect(events).toEqual([
      "pause", "sample",
      "pause", "sample",
      "pause", "sample",
      "pause", "sample",
      "next-llm-call",
    ]);
  });

  it("resets stability when a delayed browser update changes the DOM", async () => {
    const signatures = ["before", "before", "after", "after", "after"];
    const result = await waitForDomSettlement(
      async () => ({ signature: signatures.shift() || "after", readyState: "complete" }),
      async () => undefined,
      () => false,
      { minimumSamples: 3, requiredStableSamples: 3, maximumSamples: 8 },
    );

    expect(result).toEqual({ settled: true, cancelled: false, sampleCount: 5 });
    expect(signatures).toEqual([]);
  });

  it("returns a bounded timeout when the DOM keeps changing", async () => {
    let sample = 0;
    const result = await waitForDomSettlement(
      async () => ({ signature: `state-${sample += 1}`, readyState: "complete" }),
      async () => undefined,
      () => false,
      { minimumSamples: 3, requiredStableSamples: 3, maximumSamples: 5 },
    );

    expect(result).toEqual({ settled: false, cancelled: false, sampleCount: 5 });
    expect(sample).toBe(5);
  });

  it("stops sampling when the task is cancelled", async () => {
    let cancelled = false;
    let samples = 0;
    const result = await waitForDomSettlement(
      async () => {
        samples += 1;
        return { signature: "stable", readyState: "complete" };
      },
      async () => {
        cancelled = true;
      },
      () => cancelled,
    );

    expect(result).toEqual({ settled: false, cancelled: true, sampleCount: 0 });
    expect(samples).toBe(0);
  });
});

describe("automatic settlement action selection", () => {
  it.each<AgentAction>([
    { type: "click", elementId: "el-1" },
    { type: "fill", elementId: "el-1", text: "value" },
    { type: "select", elementId: "el-1", text: "option" },
    { type: "upload_file", elementId: "el-1" },
    { type: "scroll", direction: "down" },
  ])("waits after $type interactions", (action) => {
    expect(needsAutomaticDomSettlement([action])).toBe(true);
  });

  it.each<AgentAction>([
    { type: "extract" },
    { type: "read_page" },
    { type: "wait_for", waitCondition: "dom_stable" },
    { type: "navigate", url: "https://example.com" },
    { type: "done", outcome: "completed" },
  ])("does not add a second settlement barrier after $type", (action) => {
    expect(needsAutomaticDomSettlement([action])).toBe(false);
  });
});
