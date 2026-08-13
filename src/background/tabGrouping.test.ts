import { describe, expect, it } from "vitest";
import { getTabIdsForGrouping } from "./tabGrouping";

describe("lazy tab grouping", () => {
  it("does not create a group for a single tracked tab", () => {
    expect(getTabIdsForGrouping([11], [11])).toEqual([]);
  });

  it("groups the seed and new tab together on first expansion", () => {
    expect(getTabIdsForGrouping([11, 22], [22])).toEqual([11, 22]);
  });

  it("adds only requested tabs after the session group exists", () => {
    expect(getTabIdsForGrouping([11, 22, 33], [33], 7)).toEqual([33]);
  });

  it("deduplicates tab ids in the first atomic group request", () => {
    expect(getTabIdsForGrouping([11, 22], [22, 11, 22])).toEqual([11, 22]);
  });
});