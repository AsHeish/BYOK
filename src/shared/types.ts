export type Provider = "openai" | "gemini" | "groq" | "custom";
export type OpenAiApi = "responses" | "chat";
export type PromptCacheMode = "auto" | "on" | "off";

export interface JevSettings {
  mode: "off" | "shadow" | "fast";
  apiKey: string;
  // Jev requests allowed per run before the LLM planner takes over; JEV_DEFAULT_MAX_REQUESTS when unset.
  maxRequests?: number;
  // Jev model name sent with each request; JEV_MODEL when unset.
  model?: string;
  // Minimum answer confidence to act on; 0.95 to 0.99, JEV_CONFIDENCE_FLOOR when unset.
  confidenceFloor?: number;
  // Opt-in: let Jev overwrite a non-empty text field when the goal asks for a different value.
  replaceFilledFields?: boolean;
}

export type JevTimingStage = "snapshot" | "jev" | "action" | "llm";

export interface JevStageTiming {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface JevUsageSnapshot {
  requests: number;
  helperRequests?: number;
  // Model revision Jev reported on its latest answer, and how many HTTP attempts were retries.
  lastModel?: string;
  retries?: number;
  timings?: Partial<Record<JevTimingStage, JevStageTiming>>;
  lastDecision?: Array<{
    question: string;
    choice: string;
    confidence: number;
    probabilities: Array<{ option: string; probability: number }>;
  }>;
  fastDecisions: number;
  shadowDecisions: number;
  fallbacks: number;
  inputTokens: number;
  outputTokens: number;
  totalLatencyMs: number;
  estimatedCostUsd: number;
}

export interface JevTraceHead {
  question: string;
  choice: string;
  confidence: number;
  top: Array<{ option: string; probability: number }>;
}

// Holds no goal, page text, field values or labels: only ids, confidences, model revision and timings.
export interface JevTraceEntry {
  at: number;
  url: string;
  kind: "action" | "text" | "wait" | "done" | "fallback";
  operation: string;
  outcome: "fast" | "shadow" | "fallback";
  reason: string;
  model?: string;
  attempts?: number;
  elapsedMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  ignoredAnswers?: string[];
  heads: JevTraceHead[];
}

export interface AgentSettings {
  provider: Provider;
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  openAiApi?: OpenAiApi;
  maxSteps: number;
  requestTimeoutSeconds: number;
  promptCacheMode: PromptCacheMode;
  disableThinking?: boolean;
  inputTokenCostPerMillion?: number;
  cachedInputTokenCostPerMillion?: number;
  outputTokenCostPerMillion?: number;
  saveRunHistory: boolean;
  theme: "light" | "dark";
  jev?: JevSettings;
}

export interface AiConfigurationProfile {
  id: string;
  name: string;
  provider: Provider;
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  openAiApi?: OpenAiApi;
  maxSteps: number;
  requestTimeoutSeconds: number;
  promptCacheMode: PromptCacheMode;
  disableThinking?: boolean;
  inputTokenCostPerMillion?: number;
  cachedInputTokenCostPerMillion?: number;
  outputTokenCostPerMillion?: number;
  createdAt: number;
  updatedAt: number;
}

export type RiskLevel = "low" | "medium" | "high";

export type AgentActionType =
  | "click"
  | "multi_click"
  | "drag"
  | "multi_drag"
  | "upload_file"
  | "fill"
  | "type"
  | "select"
  | "press_key"
  | "summarize_page"
  | "read_page"
  | "inspect_screenshot"
  | "summarize_pdf"
  | "list_downloads"
  | "scroll"
  | "navigate"
  | "go_back"
  | "go_forward"
  | "reload"
  | "open_tab"
  | "switch_tab"
  | "close_tab"
  | "wait_for"
  | "extract"
  | "ask_user"
  | "done";

export interface AgentDragPair {
  elementId: string;
  targetElementId: string;
}

export interface AgentActionGuard {
  id: string;
  documentId: string;
  formState?: string;
  // Per-target state of the control's own group; when present it replaces the page-wide formState check.
  scopes?: Record<string, string>;
  // Set only by the Jev path when the user opted in; lets a fill overwrite a non-empty, non-sensitive field.
  replaceExisting?: boolean;
  url: string;
  targets: Record<string, string>;
}

export interface AgentAction {
  type: AgentActionType;
  guard?: AgentActionGuard;
  elementId?: string;
  elementIds?: string[];
  targetElementId?: string;
  dragPairs?: AgentDragPair[];
  fileId?: string;
  downloadId?: number;
  maxItems?: number;
  text?: string;
  key?: "Tab" | "Shift+Tab" | "PageUp" | "PageDown";
  url?: string;
  tabAlias?: string;
  direction?: "up" | "down" | "left" | "right";
  outcome?: "completed" | "partial";
  waitCondition?: WaitCondition;
  timeoutMs?: number;
}

export type WaitCondition =
  | "document_ready"
  | "dom_stable"
  | "url_changed"
  | "text_present"
  | "text_absent"
  | "element_hidden"
  | "element_enabled";

export interface AgentRequirementItemProposal {
  label: string;
}

export interface AgentRequirementProposal {
  text: string;
  expectedItemCount?: number;
  items?: AgentRequirementItemProposal[];
}

export interface AgentRequirementItemUpdate {
  itemId: string;
  status: RequirementStatus;
  evidenceIds?: string[];
  blockedReason?: string;
}

export interface AgentRequirementUpdate {
  requirementId: string;
  status?: RequirementStatus;
  evidenceIds?: string[];
  blockedReason?: string;
  expectedItemCount?: number;
  addItems?: AgentRequirementItemProposal[];
  itemUpdates?: AgentRequirementItemUpdate[];
}

export interface AgentModelResponse {
  mode: "chat" | "browser";
  thought_summary: string;
  risk_level: RiskLevel;
  navigationGoal?: string;
  action?: AgentAction;
  actions?: AgentAction[];
  requirements?: AgentRequirementProposal[];
  requirementUpdates?: AgentRequirementUpdate[];
}

export interface ModelUsageEvent {
  provider: Provider;
  model: string;
  promptTokens?: number;
  cachedPromptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  elapsedMs: number;
  attempts: number;
  status: number | "timeout";
  ok: boolean;
  timestamp: number;
}

export interface AgentUsageSnapshot {
  jev?: JevUsageSnapshot;
  requestCount: number;
  successfulRequestCount: number;
  cacheHitRequestCount: number;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalLatencyMs: number;
  averageLatencyMs?: number;
  lastLatencyMs?: number;
  lastStatus?: number | "timeout";
  estimatedCostUsd?: number;
  costConfigured: boolean;
  provider?: Provider;
  model?: string;
  updatedAt?: number;
}

export type RunStatus =
  | "running"
  | "completed"
  | "partial"
  | "blocked"
  | "stopped"
  | "failed"
  | "step_limit"
  | "interrupted";

export type RequirementStatus = "pending" | "satisfied" | "blocked";

export interface RunRequirementItem {
  id: string;
  label: string;
  status: RequirementStatus;
  evidenceIds: string[];
  blockedReason?: string;
}

export interface RunRequirement {
  id: string;
  text: string;
  status: RequirementStatus;
  evidenceIds: string[];
  blockedReason?: string;
  expectedItemCount?: number;
  items?: RunRequirementItem[];
  createdAt: number;
  updatedAt: number;
}

export interface RunEvidence {
  id: string;
  kind: "observation" | "action" | "finding" | "download" | "user";
  summary: string;
  tabAlias?: string;
  url?: string;
  createdAt: number;
}

export interface RunFinding {
  id: string;
  tabAlias: string;
  label: string;
  url?: string;
  text: string;
  createdAt: number;
}

export interface RunReport {
  id: string;
  task: string;
  status: RunStatus;
  startUrl: string;
  startTitle?: string;
  requirements: RunRequirement[];
  evidence: RunEvidence[];
  findings: RunFinding[];
  finalReport?: string;
  failureReason?: string;
  usage: AgentUsageSnapshot;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
}

export interface DomElementInfo {
  id: string;
  fingerprint?: string;
  scopeState?: string;
  tag: string;
  frameContext?: string;
  rootContext?: string;
  role?: string;
  type?: string;
  text?: string;
  label?: string;
  name?: string;
  placeholder?: string;
  accept?: string;
  context?: string;
  questionNumber?: string;
  value?: string;
  checkedState?: "checked" | "unchecked" | "mixed";
  href?: string;
  options?: string[];
  isDraggable?: boolean;
  isDropTarget?: boolean;
  isFocused?: boolean;
  isExpanded?: boolean;
  isSelected?: boolean;
  isReadOnly?: boolean;
  isDisabled: boolean;
  isSensitive: boolean;
}

export interface PageObservation {
  documentId?: string;
  formState?: string;
  isLoading?: boolean;
  url: string;
  title: string;
  text: string;
  elements: DomElementInfo[];
  interactiveElementCount?: number;
  // Visible radio groups on the page and how many have no selected option; absent when there are none.
  choiceGroups?: { total: number; unanswered: number };
  viewport?: PageViewportInfo;
  frames?: PageFrameInfo[];
}

export interface PageViewportInfo {
  scrollContainerId?: string;
  scrollContainerLabel?: string;
  scrollX: number;
  scrollY: number;
  viewportWidth: number;
  viewportHeight: number;
  pageWidth: number;
  pageHeight: number;
  progressPercent: number;
}

export interface PageFrameInfo {
  id: string;
  title?: string;
  url?: string;
  accessible: boolean;
  reason?: string;
}

export interface FullPageDocument {
  url: string;
  title: string;
  byline?: string;
  excerpt?: string;
  markdown: string;
  sourceCharacters: number;
  truncated: boolean;
}

export interface ContentWaitCheckRequest {
  condition: WaitCondition;
  text?: string;
  elementId?: string;
  baselineUrl?: string;
}

export interface ContentWaitCheckResult {
  matched: boolean;
  signature: string;
  url: string;
  readyState: DocumentReadyState;
}

export interface StagedUploadFile {
  id: string;
  name: string;
  type: string;
  size: number;
  dataUrl: string;
  createdAt: number;
}

export interface ContentActionResult {
  ok: boolean;
  message: string;
  recoverable?: boolean;
  notExecuted?: boolean;
  observation?: PageObservation;
  data?: unknown;
}

export interface ExtractedPageData {
  url: string;
  title: string;
  headings: string[];
  links: Array<{ text: string; href: string }>;
  tables: Array<{ caption?: string; headers: string[]; rows: string[][] }>;
  forms: Array<{ labels: string[]; controls: DomElementInfo[] }>;
  text: string;
}

export interface AgentLogEntry {
  id: string;
  level: "info" | "success" | "warning" | "error";
  message: string;
  // Plain text, e.g. raw model output; never parsed as markdown.
  details?: string;
  timestamp: number;
}

export interface ModelRetryStatus {
  message: string;
  attempt: number;
  maxAttempts: number;
}

export interface AgentChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  kind: "message" | "answer" | "question" | "error";
  timestamp: number;
  runId?: string;
  responseTimeMs?: number;
}

export interface SafetyDecision {
  allowed: boolean;
  recoverable?: boolean;
  riskLevel: RiskLevel;
  reason: string;
}

export type SidePanelToBackgroundMessage =
  | { type: "SIDEPANEL_SEND_CHAT"; message: string; settings: AgentSettings }
  | { type: "SIDEPANEL_RUN_TASK"; task: string; settings: AgentSettings }
  | { type: "SIDEPANEL_TEST_MODEL_CONNECTION"; settings: AgentSettings; target?: "jev" }
  | { type: "SIDEPANEL_STOP_TASK" }
  | { type: "SIDEPANEL_CLEAR_CHAT" }
  | { type: "SIDEPANEL_GET_JEV_TRACE" }
  | { type: "SIDEPANEL_GET_STATE" };

export type BackgroundToSidePanelMessage =
  | { type: "AGENT_LOG"; entry: AgentLogEntry }
  | { type: "AGENT_CHAT_MESSAGE"; message: AgentChatMessage }
  | { type: "AGENT_CHAT_CLEARED" }
  | { type: "AGENT_STATUS"; running: boolean; taskId?: string }
  | { type: "AGENT_MODEL_STATUS"; waiting: boolean }
  | { type: "AGENT_MODEL_RETRY_STATUS"; status: ModelRetryStatus | null }
  | { type: "USAGE_UPDATE"; usage: AgentUsageSnapshot };

export type BackgroundToContentMessage =
  | { type: "CONTENT_OBSERVE"; maxElements?: number }
  | { type: "CONTENT_EXECUTE"; action: AgentAction }
  | { type: "CONTENT_READ_PAGE" }
  | { type: "CONTENT_CHECK_WAIT"; request: ContentWaitCheckRequest };

export type ContentToBackgroundResponse =
  | PageObservation
  | ContentActionResult
  | FullPageDocument
  | ContentWaitCheckResult;
