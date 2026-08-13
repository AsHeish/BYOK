import { describe, expect, it } from "vitest";
import type { AgentRequirementUpdate, RunEvidence } from "../shared/types";
import { createRequirements, getCompletionLedgerIssues, updateRequirements } from "./runLedger";

const issueLabels = ["Issue 101", "Issue 102", "Issue 103"];

function evidence(id: string): RunEvidence {
  return {
    id,
    kind: "finding",
    summary: `Summary backed by ${id}`,
    createdAt: 1,
  };
}

function createIssueRequirements() {
  return createRequirements(
    "Open every issue and summarize it",
    [{
      text: "Summarize every visible issue",
      expectedItemCount: 3,
      items: issueLabels.map((label) => ({ label })),
    }],
    1,
  );
}

describe("requirement completion ledger", () => {
  it("rejects completion after only one of three issues is summarized", () => {
    const requirements = createIssueRequirements();
    const items = requirements[0].items || [];
    expect(items).toHaveLength(3);

    const updated = updateRequirements(
      requirements,
      [{
        requirementId: requirements[0].id,
        itemUpdates: [{ itemId: items[0].id, status: "satisfied", evidenceIds: ["finding-1"] }],
      }],
      [evidence("finding-1")],
      2,
    ).requirements;

    expect(updated[0].items?.filter((item) => item.status === "satisfied")).toHaveLength(1);
    const issues = getCompletionLedgerIssues(
      { task: "Open every issue and summarize it", requirements: updated, evidence: [evidence("finding-1")] },
      "completed",
    );
    expect(issues.some((issue) => issue.includes(items[1].id) && issue.includes("pending"))).toBe(true);
    expect(issues.some((issue) => issue.includes(items[2].id) && issue.includes("pending"))).toBe(true);
  });

  it("does not accept invented evidence IDs", () => {
    const requirements = createRequirements("Summarize this page", [{ text: "Summarize the page" }], 1);
    const updated = updateRequirements(
      requirements,
      [{ requirementId: requirements[0].id, status: "satisfied", evidenceIds: ["invented"] }],
      [evidence("real-evidence")],
      2,
    ).requirements;

    expect(updated[0].status).toBe("pending");
    expect(getCompletionLedgerIssues({ task: "Summarize this page", requirements: updated, evidence: [evidence("real-evidence")] }, "completed"))
      .toContain(`${requirements[0].id} is still pending.`);
  });

  it("accepts completion only after all three discovered issues have evidence", () => {
    const requirements = createIssueRequirements();
    const items = requirements[0].items || [];
    expect(items).toHaveLength(3);
    const evidenceList = items.map((_, index) => evidence(`finding-${index + 1}`));
    const updates: AgentRequirementUpdate[] = [{
      requirementId: requirements[0].id,
      itemUpdates: items.map((item, index) => ({
        itemId: item.id,
        status: "satisfied",
        evidenceIds: [evidenceList[index].id],
      })),
    }];
    const updated = updateRequirements(requirements, updates, evidenceList, 2).requirements;

    expect(updated[0].items?.every((item) => item.status === "satisfied")).toBe(true);
    expect(updated[0].status).toBe("satisfied");
    expect(getCompletionLedgerIssues({ task: "Open every issue and summarize it", requirements: updated, evidence: evidenceList }, "completed")).toEqual([]);
  });

  it("rejects a vacuous item list below the declared expected count", () => {
    const requirements = createRequirements(
      "Summarize three issues",
      [{
        text: "Summarize every issue",
        expectedItemCount: 3,
        items: issueLabels.slice(0, 2).map((label) => ({ label })),
      }],
      1,
    );
    const items = requirements[0].items || [];
    expect(items).toHaveLength(2);
    expect(requirements[0].expectedItemCount).toBe(3);
    const evidenceList = items.map((_, index) => evidence(`finding-${index + 1}`));
    const updated = updateRequirements(
      requirements,
      [{
        requirementId: requirements[0].id,
        itemUpdates: items.map((item, index) => ({
          itemId: item.id,
          status: "satisfied",
          evidenceIds: [evidenceList[index].id],
        })),
      }],
      evidenceList,
      2,
    ).requirements;

    expect(getCompletionLedgerIssues({ task: "Summarize three issues", requirements: updated, evidence: evidenceList }, "completed"))
      .toContain(`${requirements[0].id} discovered 2 of 3 expected items.`);
  });

  it("allows partial completion only when every unfinished item is explicitly blocked", () => {
    const requirements = createIssueRequirements();
    const items = requirements[0].items || [];
    const evidenceList = [evidence("finding-1")];
    const updated = updateRequirements(
      requirements,
      [{
        requirementId: requirements[0].id,
        itemUpdates: [
          { itemId: items[0].id, status: "satisfied", evidenceIds: ["finding-1"] },
          { itemId: items[1].id, status: "blocked", blockedReason: "Requires repository access" },
          { itemId: items[2].id, status: "blocked", blockedReason: "Issue was deleted" },
        ],
      }],
      evidenceList,
      2,
    ).requirements;

    expect(getCompletionLedgerIssues({ task: "Open every issue and summarize it", requirements: updated, evidence: evidenceList }, "partial")).toEqual([]);
    expect(getCompletionLedgerIssues({ task: "Open every issue and summarize it", requirements: updated, evidence: evidenceList }, "completed").length).toBeGreaterThan(0);
  });

  it("rejects an every-item task when the model never enumerated the items", () => {
    const requirements = createRequirements(
      "Open every issue and summarize it",
      [{ text: "Summarize the issues" }],
      1,
    );
    const evidenceList = [evidence("generic-observation")];
    const updated = updateRequirements(
      requirements,
      [{ requirementId: requirements[0].id, status: "satisfied", evidenceIds: ["generic-observation"] }],
      evidenceList,
      2,
    ).requirements;

    expect(updated).toHaveLength(1);
    expect(updated[0].items).toBeUndefined();
    expect(getCompletionLedgerIssues(
      { task: "Open every issue and summarize it", requirements: updated, evidence: evidenceList },
      "completed",
    )).toContain("The multi-item task has no enumerated item list or expected item count.");
  });
});
