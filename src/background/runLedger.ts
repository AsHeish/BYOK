import { createId } from "../shared/ids";
import type {
  AgentAction,
  AgentRequirementProposal,
  AgentRequirementUpdate,
  RunEvidence,
  RunReport,
  RunRequirement,
  RunRequirementItem,
} from "../shared/types";

export function createRequirements(
  task: string,
  proposals?: AgentRequirementProposal[],
  now = Date.now(),
): RunRequirement[] {
  const source = proposals?.length ? proposals : [{ text: task }];
  return source.slice(0, 50).map((proposal) => {
    const items = createRequirementItems(proposal.items?.map((item) => item.label) || []);
    return {
      id: createId("req"),
      text: proposal.text,
      status: "pending",
      evidenceIds: [],
      expectedItemCount: normalizeExpectedItemCount(proposal.expectedItemCount, items.length),
      items: items.length ? items : undefined,
      createdAt: now,
      updatedAt: now,
    };
  });
}

export function updateRequirements(
  requirements: RunRequirement[],
  updates: AgentRequirementUpdate[] | undefined,
  evidence: RunEvidence[],
  now = Date.now(),
): { requirements: RunRequirement[]; changed: boolean } {
  if (!updates?.length || requirements.length === 0) {
    return { requirements, changed: false };
  }

  const validEvidenceIds = new Set(evidence.map((item) => item.id));
  let changed = false;
  const nextRequirements = requirements.map((requirement) => {
    const update = updates.find((candidate) => candidate.requirementId === requirement.id);
    if (!update) {
      return requirement;
    }

    changed = true;
    const next = { ...requirement, items: requirement.items ? [...requirement.items] : undefined };
    if (update.expectedItemCount !== undefined) {
      next.expectedItemCount = Math.max(next.expectedItemCount || 0, Math.floor(update.expectedItemCount));
    }

    if (update.addItems?.length) {
      const existingLabels = new Set((next.items || []).map((item) => normalizeLedgerLabel(item.label)));
      const newLabels = update.addItems
        .map((item) => item.label)
        .filter((label) => !existingLabels.has(normalizeLedgerLabel(label)));
      const newItems = createRequirementItems(newLabels);
      next.items = [...(next.items || []), ...newItems];
      if (newItems.length && next.expectedItemCount === undefined) {
        next.expectedItemCount = next.items.length;
      }
    }

    if (update.itemUpdates?.length && next.items?.length) {
      next.items = next.items.map((item) => {
        const itemUpdate = update.itemUpdates?.find((candidate) => candidate.itemId === item.id);
        return itemUpdate ? applyItemUpdate(item, itemUpdate, validEvidenceIds) : item;
      });
    }

    if (!next.items?.length && update.status) {
      applyRequirementStatus(next, update, validEvidenceIds);
    }

    reconcileRequirementFromItems(next);
    next.updatedAt = now;
    return next;
  });

  return { requirements: nextRequirements, changed };
}

export function getCompletionLedgerIssues(
  report: Pick<RunReport, "task" | "requirements" | "evidence">,
  outcome: AgentAction["outcome"],
): string[] {
  const issues: string[] = [];
  if (!outcome) {
    issues.push("done requires outcome=completed or outcome=partial.");
  }
  if (report.requirements.length === 0) {
    issues.push("The requirement ledger is empty.");
    return issues;
  }
  if (isExplicitMultiItemTask(report.task) && !report.requirements.some(hasEnumeratedItems)) {
    issues.push("The multi-item task has no enumerated item list or expected item count.");
  }

  const validEvidenceIds = new Set(report.evidence.map((evidence) => evidence.id));
  for (const requirement of report.requirements) {
    const items = requirement.items || [];
    if (requirement.expectedItemCount !== undefined && items.length < requirement.expectedItemCount) {
      issues.push(`${requirement.id} discovered ${items.length} of ${requirement.expectedItemCount} expected items.`);
    }

    for (const item of items) {
      issues.push(...getLedgerEntryIssues(`${requirement.id}/${item.id}`, item, outcome, validEvidenceIds));
    }
    issues.push(...getLedgerEntryIssues(requirement.id, requirement, outcome, validEvidenceIds));
  }
  return issues.slice(0, 20);
}

function isExplicitMultiItemTask(task: string): boolean {
  return /\b(?:each|every)\b|\ball\s+(?:issues?|items?|tabs?|links?|rows?|pages?|products?|results?|files?|records?|entries?|tickets?|pull\s+requests?)\b/i.test(task);
}

function hasEnumeratedItems(requirement: RunRequirement): boolean {
  return requirement.expectedItemCount !== undefined || Boolean(requirement.items?.length);
}

function createRequirementItems(labels: string[]): RunRequirementItem[] {
  const seen = new Set<string>();
  return labels
    .map((label) => label.trim())
    .filter((label) => {
      const normalized = normalizeLedgerLabel(label);
      if (!normalized || seen.has(normalized)) {
        return false;
      }
      seen.add(normalized);
      return true;
    })
    .slice(0, 200)
    .map((label) => ({
      id: createId("item"),
      label,
      status: "pending" as const,
      evidenceIds: [],
    }));
}

function applyItemUpdate(
  item: RunRequirementItem,
  update: NonNullable<AgentRequirementUpdate["itemUpdates"]>[number],
  validEvidenceIds: Set<string>,
): RunRequirementItem {
  const next = { ...item };
  const evidenceIds = filterValidEvidenceIds(update.evidenceIds, validEvidenceIds);
  if (update.status === "satisfied" && evidenceIds.length) {
    next.status = "satisfied";
    next.evidenceIds = evidenceIds;
    next.blockedReason = undefined;
  } else if (update.status === "blocked" && update.blockedReason?.trim()) {
    next.status = "blocked";
    next.evidenceIds = evidenceIds;
    next.blockedReason = update.blockedReason.trim();
  } else if (update.status === "pending") {
    next.status = "pending";
    next.evidenceIds = [];
    next.blockedReason = undefined;
  }
  return next;
}

function applyRequirementStatus(
  requirement: RunRequirement,
  update: AgentRequirementUpdate,
  validEvidenceIds: Set<string>,
): void {
  const evidenceIds = filterValidEvidenceIds(update.evidenceIds, validEvidenceIds);
  if (update.status === "satisfied" && evidenceIds.length) {
    requirement.status = "satisfied";
    requirement.evidenceIds = evidenceIds;
    requirement.blockedReason = undefined;
  } else if (update.status === "blocked" && update.blockedReason?.trim()) {
    requirement.status = "blocked";
    requirement.evidenceIds = evidenceIds;
    requirement.blockedReason = update.blockedReason.trim();
  } else if (update.status === "pending") {
    requirement.status = "pending";
    requirement.evidenceIds = [];
    requirement.blockedReason = undefined;
  }
}

function reconcileRequirementFromItems(requirement: RunRequirement): void {
  const items = requirement.items || [];
  if (!items.length) {
    return;
  }

  const countIncomplete = requirement.expectedItemCount !== undefined && items.length < requirement.expectedItemCount;
  const pending = countIncomplete || items.some((item) => item.status === "pending");
  const blocked = items.filter((item) => item.status === "blocked");
  requirement.evidenceIds = [...new Set(items.flatMap((item) => item.evidenceIds))];

  if (pending) {
    requirement.status = "pending";
    requirement.blockedReason = undefined;
  } else if (blocked.length) {
    requirement.status = "blocked";
    requirement.blockedReason = blocked.map((item) => `${item.label}: ${item.blockedReason}`).join("; ");
  } else {
    requirement.status = "satisfied";
    requirement.blockedReason = undefined;
  }
}

function getLedgerEntryIssues(
  label: string,
  entry: Pick<RunRequirement, "status" | "evidenceIds" | "blockedReason">,
  outcome: AgentAction["outcome"],
  validEvidenceIds: Set<string>,
): string[] {
  if (entry.status === "pending") {
    return [`${label} is still pending.`];
  }
  if (entry.status === "satisfied") {
    return entry.evidenceIds.some((id) => validEvidenceIds.has(id))
      ? []
      : [`${label} is marked satisfied without valid evidence.`];
  }
  if (outcome === "completed") {
    return [`${label} is blocked, so outcome must be partial.`];
  }
  return entry.blockedReason?.trim() ? [] : [`${label} is blocked without a reason.`];
}

function filterValidEvidenceIds(evidenceIds: string[] | undefined, validIds: Set<string>): string[] {
  return [...new Set((evidenceIds || []).filter((id) => validIds.has(id)))];
}

function normalizeExpectedItemCount(value: number | undefined, itemCount: number): number | undefined {
  if (value !== undefined && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return itemCount > 0 ? itemCount : undefined;
}

function normalizeLedgerLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}
