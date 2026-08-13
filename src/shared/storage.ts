import { DEFAULT_SETTINGS } from "./defaults";
import type {
  AgentSettings,
  AgentUsageSnapshot,
  AiConfigurationProfile,
  PromptCacheMode,
  Provider,
  RequirementStatus,
  RunEvidence,
  RunFinding,
  RunReport,
  RunRequirement,
  RunRequirementItem,
  RunStatus,
  StagedUploadFile,
} from "./types";

const SETTINGS_KEY = "byokAgentSettings";
const TASK_DRAFT_KEY = "byokAgentTaskDraft";
const CONFIG_PROFILES_KEY = "byokAgentConfigProfiles";
const STAGED_UPLOAD_FILE_KEY = "byokAgentStagedUploadFile";
export const RUN_REPORTS_KEY = "byokAgentRunReports";
const MIN_MAX_STEPS = 1;
const MAX_MAX_STEPS = 60;
const LEGACY_DEFAULT_MAX_STEPS = new Set([12, 30]);
const MIN_REQUEST_TIMEOUT_SECONDS = 10;
const MAX_REQUEST_TIMEOUT_SECONDS = 300;
const MAX_RUN_REPORTS = 50;
const MAX_RUN_REPORT_STORAGE_CHARS = 2_000_000;
const MAX_REQUIREMENTS_PER_RUN = 200;
const MAX_EVIDENCE_PER_RUN = 400;
const MAX_FINDINGS_PER_RUN = 200;
const MAX_FINAL_REPORT_CHARS = 60_000;
const MAX_FINDING_TEXT_CHARS = 8_000;
const MAX_EVIDENCE_SUMMARY_CHARS = 1_000;

function normalizeProvider(value: unknown): Provider {
  if (
    value === "openai" ||
    value === "gemini" ||
    value === "groq" ||
    value === "custom"
  ) {
    return value;
  }
  return DEFAULT_SETTINGS.provider;
}

function normalizePromptCacheMode(value: unknown): PromptCacheMode {
  if (value === "auto" || value === "on" || value === "off") {
    return value;
  }
  return DEFAULT_SETTINGS.promptCacheMode;
}

function normalizeOptionalPrice(value: unknown): number | undefined {
  if (value === "" || value === null || typeof value === "undefined") {
    return undefined;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : undefined;
}

function clampMaxSteps(value: unknown): number {
  const numericValue = Number(value || DEFAULT_SETTINGS.maxSteps);
  return Math.min(Math.max(numericValue, MIN_MAX_STEPS), MAX_MAX_STEPS);
}

function normalizeStoredMaxSteps(value: unknown): number {
  const numericValue = Number(value || DEFAULT_SETTINGS.maxSteps);
  return LEGACY_DEFAULT_MAX_STEPS.has(numericValue)
    ? DEFAULT_SETTINGS.maxSteps
    : clampMaxSteps(numericValue);
}

export async function loadSettings(): Promise<AgentSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = stored[SETTINGS_KEY] as Partial<AgentSettings> | undefined;

  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    provider: normalizeProvider(raw?.provider),
    apiBaseUrl: String(raw?.apiBaseUrl || DEFAULT_SETTINGS.apiBaseUrl).replace(
      /\/+$/,
      "",
    ),
    apiKey: String(raw?.apiKey || ""),
    model: String(raw?.model || DEFAULT_SETTINGS.model),
    maxSteps: normalizeStoredMaxSteps(raw?.maxSteps),
    requestTimeoutSeconds: Math.min(
      Math.max(
        Number(raw?.requestTimeoutSeconds || DEFAULT_SETTINGS.requestTimeoutSeconds),
        MIN_REQUEST_TIMEOUT_SECONDS,
      ),
      MAX_REQUEST_TIMEOUT_SECONDS,
    ),
    promptCacheMode: normalizePromptCacheMode(raw?.promptCacheMode),
    inputTokenCostPerMillion: normalizeOptionalPrice(raw?.inputTokenCostPerMillion),
    cachedInputTokenCostPerMillion: normalizeOptionalPrice(raw?.cachedInputTokenCostPerMillion),
    outputTokenCostPerMillion: normalizeOptionalPrice(raw?.outputTokenCostPerMillion),
    saveRunHistory: raw?.saveRunHistory !== false,
    theme:
      raw?.theme === "light" || raw?.theme === "dark"
        ? raw.theme
        : DEFAULT_SETTINGS.theme,
  };
}

export async function saveSettings(settings: AgentSettings): Promise<void> {
  // chrome.storage.local is profile-local extension storage. It is not a secure vault.
  // Users should prefer scoped, revocable BYOK keys and browser profile protections.
  await chrome.storage.local.set({
    [SETTINGS_KEY]: {
      ...settings,
      apiBaseUrl: settings.apiBaseUrl.replace(/\/+$/, ""),
      maxSteps: clampMaxSteps(settings.maxSteps),
      requestTimeoutSeconds: Math.min(
        Math.max(settings.requestTimeoutSeconds, MIN_REQUEST_TIMEOUT_SECONDS),
        MAX_REQUEST_TIMEOUT_SECONDS,
      ),
      promptCacheMode: normalizePromptCacheMode(settings.promptCacheMode),
      inputTokenCostPerMillion: normalizeOptionalPrice(settings.inputTokenCostPerMillion),
      cachedInputTokenCostPerMillion: normalizeOptionalPrice(settings.cachedInputTokenCostPerMillion),
      outputTokenCostPerMillion: normalizeOptionalPrice(settings.outputTokenCostPerMillion),
    },
  });
}

export async function loadTaskDraft(): Promise<string> {
  const stored = await chrome.storage.local.get(TASK_DRAFT_KEY);
  return String(stored[TASK_DRAFT_KEY] || "");
}

export async function saveTaskDraft(task: string): Promise<void> {
  await chrome.storage.local.set({
    [TASK_DRAFT_KEY]: task,
  });
}

export async function loadStagedUploadFile(): Promise<StagedUploadFile | undefined> {
  const stored = await chrome.storage.local.get(STAGED_UPLOAD_FILE_KEY);
  return normalizeStagedUploadFile(stored[STAGED_UPLOAD_FILE_KEY]);
}

export async function saveStagedUploadFile(file: StagedUploadFile): Promise<void> {
  await chrome.storage.local.set({
    [STAGED_UPLOAD_FILE_KEY]: file,
  });
}

export async function clearStagedUploadFile(): Promise<void> {
  await chrome.storage.local.remove(STAGED_UPLOAD_FILE_KEY);
}

export async function loadRunReports(): Promise<RunReport[]> {
  const stored = await chrome.storage.local.get(RUN_REPORTS_KEY);
  return normalizeRunReports(stored[RUN_REPORTS_KEY]);
}

export async function saveRunReport(report: RunReport): Promise<RunReport[]> {
  const reports = await loadRunReports();
  const sanitized = sanitizeRunReport(report);
  const nextReports = enforceRunReportLimits([
    sanitized,
    ...reports.filter((existing) => existing.id !== sanitized.id),
  ]);
  await chrome.storage.local.set({ [RUN_REPORTS_KEY]: nextReports });
  return nextReports;
}

export async function deleteRunReport(runId: string): Promise<RunReport[]> {
  const reports = await loadRunReports();
  const nextReports = reports.filter((report) => report.id !== runId);
  await chrome.storage.local.set({ [RUN_REPORTS_KEY]: nextReports });
  return nextReports;
}

export async function clearRunReports(): Promise<void> {
  await chrome.storage.local.remove(RUN_REPORTS_KEY);
}

export async function markInterruptedRunReports(now = Date.now()): Promise<RunReport[]> {
  const reports = await loadRunReports();
  let changed = false;
  const nextReports = reports.map((report) => {
    if (report.status !== "running") {
      return report;
    }
    changed = true;
    return {
      ...report,
      status: "interrupted" as const,
      failureReason: report.failureReason || "The extension stopped before this run finished.",
      updatedAt: now,
      endedAt: now,
    };
  });

  if (changed) {
    await chrome.storage.local.set({ [RUN_REPORTS_KEY]: nextReports });
  }
  return nextReports;
}

export async function loadConfigurationProfiles(): Promise<
  AiConfigurationProfile[]
> {
  const stored = await chrome.storage.local.get(CONFIG_PROFILES_KEY);
  return normalizeProfiles(stored[CONFIG_PROFILES_KEY]);
}

export async function saveConfigurationProfile(
  name: string,
  settings: AgentSettings,
): Promise<AiConfigurationProfile[]> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error("Profile name is required.");
  }

  const profiles = await loadConfigurationProfiles();
  const now = Date.now();
  const existing = profiles.find(
    (profile) => profile.name.toLowerCase() === trimmedName.toLowerCase(),
  );
  const savedProfile: AiConfigurationProfile = {
    id: existing?.id || createProfileId(),
    name: trimmedName,
    provider: settings.provider,
    apiBaseUrl: settings.apiBaseUrl.replace(/\/+$/, ""),
    apiKey: settings.apiKey,
    model: settings.model,
    maxSteps: clampMaxSteps(settings.maxSteps),
    requestTimeoutSeconds: Math.min(
      Math.max(settings.requestTimeoutSeconds, MIN_REQUEST_TIMEOUT_SECONDS),
      MAX_REQUEST_TIMEOUT_SECONDS,
    ),
    promptCacheMode: normalizePromptCacheMode(settings.promptCacheMode),
    inputTokenCostPerMillion: normalizeOptionalPrice(settings.inputTokenCostPerMillion),
    cachedInputTokenCostPerMillion: normalizeOptionalPrice(settings.cachedInputTokenCostPerMillion),
    outputTokenCostPerMillion: normalizeOptionalPrice(settings.outputTokenCostPerMillion),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  const nextProfiles = existing
    ? profiles.map((profile) =>
        profile.id === existing.id ? savedProfile : profile,
      )
    : [...profiles, savedProfile];

  await chrome.storage.local.set({
    [CONFIG_PROFILES_KEY]: nextProfiles,
  });
  return nextProfiles;
}

export async function deleteConfigurationProfile(
  profileId: string,
): Promise<AiConfigurationProfile[]> {
  const profiles = await loadConfigurationProfiles();
  const nextProfiles = profiles.filter((profile) => profile.id !== profileId);
  await chrome.storage.local.set({
    [CONFIG_PROFILES_KEY]: nextProfiles,
  });
  return nextProfiles;
}

export function applyConfigurationProfile(
  settings: AgentSettings,
  profile: AiConfigurationProfile,
): AgentSettings {
  return {
    ...settings,
    provider: profile.provider,
    apiBaseUrl: profile.apiBaseUrl,
    apiKey: profile.apiKey,
    model: profile.model,
    maxSteps: profile.maxSteps,
    requestTimeoutSeconds: profile.requestTimeoutSeconds,
    promptCacheMode: profile.promptCacheMode,
    inputTokenCostPerMillion: profile.inputTokenCostPerMillion,
    cachedInputTokenCostPerMillion: profile.cachedInputTokenCostPerMillion,
    outputTokenCostPerMillion: profile.outputTokenCostPerMillion,
  };
}

function normalizeProfiles(value: unknown): AiConfigurationProfile[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((profile): AiConfigurationProfile | undefined => {
      if (!profile || typeof profile !== "object") {
        return undefined;
      }

      const raw = profile as Partial<AiConfigurationProfile>;
      const name = String(raw.name || "").trim();
      if (!name) {
        return undefined;
      }

      return {
        id: String(raw.id || createProfileId()),
        name,
        provider: normalizeProvider(raw.provider),
        apiBaseUrl: String(
          raw.apiBaseUrl || DEFAULT_SETTINGS.apiBaseUrl,
        ).replace(/\/+$/, ""),
        apiKey: String(raw.apiKey || ""),
        model: String(raw.model || DEFAULT_SETTINGS.model),
        maxSteps: normalizeStoredMaxSteps(raw.maxSteps),
        requestTimeoutSeconds: Math.min(
          Math.max(
            Number(raw.requestTimeoutSeconds || DEFAULT_SETTINGS.requestTimeoutSeconds),
            MIN_REQUEST_TIMEOUT_SECONDS,
          ),
          MAX_REQUEST_TIMEOUT_SECONDS,
        ),
        promptCacheMode: normalizePromptCacheMode(raw.promptCacheMode),
        inputTokenCostPerMillion: normalizeOptionalPrice(raw.inputTokenCostPerMillion),
        cachedInputTokenCostPerMillion: normalizeOptionalPrice(raw.cachedInputTokenCostPerMillion),
        outputTokenCostPerMillion: normalizeOptionalPrice(raw.outputTokenCostPerMillion),
        createdAt: Number(raw.createdAt || Date.now()),
        updatedAt: Number(raw.updatedAt || Date.now()),
      };
    })
    .filter((profile): profile is AiConfigurationProfile => Boolean(profile))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function normalizeStagedUploadFile(value: unknown): StagedUploadFile | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const raw = value as Partial<StagedUploadFile>;
  const id = String(raw.id || "").trim();
  const name = String(raw.name || "").trim();
  const dataUrl = String(raw.dataUrl || "");
  const size = Number(raw.size || 0);
  if (!id || !name || !dataUrl.startsWith("data:") || !Number.isFinite(size) || size <= 0) {
    return undefined;
  }

  return {
    id,
    name,
    type: String(raw.type || "application/octet-stream"),
    size,
    dataUrl,
    createdAt: Number(raw.createdAt || Date.now()),
  };
}

function normalizeRunReports(value: unknown): RunReport[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return enforceRunReportLimits(
    value
      .map(normalizeRunReport)
      .filter((report): report is RunReport => Boolean(report)),
  );
}

function normalizeRunReport(value: unknown): RunReport | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const raw = value as Partial<RunReport>;
  const id = String(raw.id || "").trim();
  const task = String(raw.task || "").trim();
  const startUrl = String(raw.startUrl || "").trim();
  if (!id || !task || !startUrl) {
    return undefined;
  }

  return sanitizeRunReport({
    id,
    task,
    status: normalizeRunStatus(raw.status),
    startUrl,
    startTitle: optionalString(raw.startTitle),
    requirements: Array.isArray(raw.requirements)
      ? raw.requirements.map(normalizeRequirement).filter((item): item is RunRequirement => Boolean(item))
      : [],
    evidence: Array.isArray(raw.evidence)
      ? raw.evidence.map(normalizeEvidence).filter((item): item is RunEvidence => Boolean(item))
      : [],
    findings: Array.isArray(raw.findings)
      ? raw.findings.map(normalizeFinding).filter((item): item is RunFinding => Boolean(item))
      : [],
    finalReport: optionalString(raw.finalReport),
    failureReason: optionalString(raw.failureReason),
    usage: normalizeUsage(raw.usage),
    startedAt: finiteNumber(raw.startedAt, Date.now()),
    updatedAt: finiteNumber(raw.updatedAt, Date.now()),
    endedAt: optionalFiniteNumber(raw.endedAt),
  });
}

function sanitizeRunReport(report: RunReport): RunReport {
  return {
    ...report,
    task: report.task.slice(0, 10_000),
    startUrl: report.startUrl.slice(0, 2_000),
    startTitle: report.startTitle?.slice(0, 500),
    requirements: report.requirements.slice(0, MAX_REQUIREMENTS_PER_RUN).map(sanitizeRequirement),
    evidence: report.evidence.slice(-MAX_EVIDENCE_PER_RUN).map(sanitizeEvidence),
    findings: report.findings.slice(-MAX_FINDINGS_PER_RUN).map(sanitizeFinding),
    finalReport: report.finalReport?.slice(0, MAX_FINAL_REPORT_CHARS),
    failureReason: report.failureReason?.slice(0, 4_000),
    usage: normalizeUsage(report.usage),
  };
}

function normalizeRequirement(value: unknown): RunRequirement | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Partial<RunRequirement>;
  const id = String(raw.id || "").trim();
  const text = String(raw.text || "").trim();
  if (!id || !text) {
    return undefined;
  }
  return sanitizeRequirement({
    id,
    text,
    status: normalizeRequirementStatus(raw.status),
    evidenceIds: stringArray(raw.evidenceIds),
    blockedReason: optionalString(raw.blockedReason),
    expectedItemCount: optionalFiniteNumber(raw.expectedItemCount),
    items: Array.isArray(raw.items)
      ? raw.items.map(normalizeRequirementItem).filter((item): item is RunRequirementItem => Boolean(item))
      : undefined,
    createdAt: finiteNumber(raw.createdAt, Date.now()),
    updatedAt: finiteNumber(raw.updatedAt, Date.now()),
  });
}

function sanitizeRequirement(requirement: RunRequirement): RunRequirement {
  return {
    ...requirement,
    id: requirement.id.slice(0, 120),
    text: requirement.text.slice(0, 2_000),
    evidenceIds: requirement.evidenceIds.slice(0, 200).map((id) => id.slice(0, 120)),
    blockedReason: requirement.blockedReason?.slice(0, 2_000),
    items: requirement.items?.slice(0, 500).map(sanitizeRequirementItem),
  };
}

function normalizeRequirementItem(value: unknown): RunRequirementItem | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Partial<RunRequirementItem>;
  const id = String(raw.id || "").trim();
  const label = String(raw.label || "").trim();
  if (!id || !label) {
    return undefined;
  }
  return sanitizeRequirementItem({
    id,
    label,
    status: normalizeRequirementStatus(raw.status),
    evidenceIds: stringArray(raw.evidenceIds),
    blockedReason: optionalString(raw.blockedReason),
  });
}

function sanitizeRequirementItem(item: RunRequirementItem): RunRequirementItem {
  return {
    ...item,
    id: item.id.slice(0, 120),
    label: item.label.slice(0, 1_000),
    evidenceIds: item.evidenceIds.slice(0, 100).map((id) => id.slice(0, 120)),
    blockedReason: item.blockedReason?.slice(0, 1_000),
  };
}

function normalizeEvidence(value: unknown): RunEvidence | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Partial<RunEvidence>;
  const id = String(raw.id || "").trim();
  const summary = String(raw.summary || "").trim();
  if (!id || !summary) {
    return undefined;
  }
  const kind = raw.kind;
  if (kind !== "observation" && kind !== "action" && kind !== "finding" && kind !== "download" && kind !== "user") {
    return undefined;
  }
  return sanitizeEvidence({
    id,
    kind,
    summary,
    tabAlias: optionalString(raw.tabAlias),
    url: optionalString(raw.url),
    createdAt: finiteNumber(raw.createdAt, Date.now()),
  });
}

function sanitizeEvidence(evidence: RunEvidence): RunEvidence {
  return {
    ...evidence,
    id: evidence.id.slice(0, 120),
    summary: evidence.summary.slice(0, MAX_EVIDENCE_SUMMARY_CHARS),
    tabAlias: evidence.tabAlias?.slice(0, 120),
    url: evidence.url?.slice(0, 2_000),
  };
}

function normalizeFinding(value: unknown): RunFinding | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Partial<RunFinding>;
  const id = String(raw.id || "").trim();
  const tabAlias = String(raw.tabAlias || "").trim();
  const label = String(raw.label || "").trim();
  const text = String(raw.text || "").trim();
  if (!id || !tabAlias || !label || !text) {
    return undefined;
  }
  return sanitizeFinding({
    id,
    tabAlias,
    label,
    url: optionalString(raw.url),
    text,
    createdAt: finiteNumber(raw.createdAt, Date.now()),
  });
}

function sanitizeFinding(finding: RunFinding): RunFinding {
  return {
    ...finding,
    id: finding.id.slice(0, 120),
    tabAlias: finding.tabAlias.slice(0, 120),
    label: finding.label.slice(0, 1_000),
    url: finding.url?.slice(0, 2_000),
    text: finding.text.slice(0, MAX_FINDING_TEXT_CHARS),
  };
}

function normalizeUsage(value: unknown): AgentUsageSnapshot {
  const raw = value && typeof value === "object" ? value as Partial<AgentUsageSnapshot> : {};
  return {
    requestCount: finiteNumber(raw.requestCount, 0),
    successfulRequestCount: finiteNumber(raw.successfulRequestCount, 0),
    cacheHitRequestCount: finiteNumber(raw.cacheHitRequestCount, 0),
    promptTokens: finiteNumber(raw.promptTokens, 0),
    cachedPromptTokens: finiteNumber(raw.cachedPromptTokens, 0),
    completionTokens: finiteNumber(raw.completionTokens, 0),
    totalTokens: finiteNumber(raw.totalTokens, 0),
    totalLatencyMs: finiteNumber(raw.totalLatencyMs, 0),
    averageLatencyMs: optionalFiniteNumber(raw.averageLatencyMs),
    lastLatencyMs: optionalFiniteNumber(raw.lastLatencyMs),
    lastStatus: raw.lastStatus === "timeout" || typeof raw.lastStatus === "number" ? raw.lastStatus : undefined,
    estimatedCostUsd: optionalFiniteNumber(raw.estimatedCostUsd),
    costConfigured: Boolean(raw.costConfigured),
    provider: normalizeOptionalProvider(raw.provider),
    model: optionalString(raw.model),
    updatedAt: optionalFiniteNumber(raw.updatedAt),
  };
}

function enforceRunReportLimits(reports: RunReport[]): RunReport[] {
  const sorted = [...reports].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_RUN_REPORTS);
  const selected: RunReport[] = [];
  let usedChars = 2;
  for (const report of sorted) {
    const reportChars = JSON.stringify(report).length + 1;
    if (selected.length > 0 && usedChars + reportChars > MAX_RUN_REPORT_STORAGE_CHARS) {
      continue;
    }
    selected.push(report);
    usedChars += reportChars;
  }
  return selected;
}

function normalizeRunStatus(value: unknown): RunStatus {
  const allowed: RunStatus[] = ["running", "completed", "partial", "blocked", "stopped", "failed", "step_limit", "interrupted"];
  return allowed.includes(value as RunStatus) ? value as RunStatus : "failed";
}

function normalizeRequirementStatus(value: unknown): RequirementStatus {
  return value === "satisfied" || value === "blocked" ? value : "pending";
}

function normalizeOptionalProvider(value: unknown): Provider | undefined {
  return value === "openai" || value === "gemini" || value === "groq" || value === "custom" ? value : undefined;
}

function finiteNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
    : [];
}

function createProfileId(): string {
  return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
