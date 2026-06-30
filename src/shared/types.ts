export type Provider = "openai" | "gemini" | "groq" | "custom";
export type PromptCacheMode = "auto" | "on" | "off";

export interface AgentSettings {
  provider: Provider;
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  maxSteps: number;
  requestTimeoutSeconds: number;
  promptCacheMode: PromptCacheMode;
  inputTokenCostPerMillion?: number;
  cachedInputTokenCostPerMillion?: number;
  outputTokenCostPerMillion?: number;
  theme: "light" | "dark";
}

export interface AiConfigurationProfile {
  id: string;
  name: string;
  provider: Provider;
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  maxSteps: number;
  requestTimeoutSeconds: number;
  promptCacheMode: PromptCacheMode;
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
  | "extract"
  | "ask_user"
  | "done";

export interface AgentDragPair {
  elementId: string;
  targetElementId: string;
}

export interface AgentAction {
  type: AgentActionType;
  elementId?: string;
  elementIds?: string[];
  targetElementId?: string;
  dragPairs?: AgentDragPair[];
  fileId?: string;
  downloadId?: number;
  maxItems?: number;
  text?: string;
  key?: "Tab" | "Shift+Tab";
  url?: string;
  tabAlias?: string;
  direction?: "up" | "down" | "left" | "right";
}

export interface AgentModelResponse {
  thought_summary: string;
  risk_level: RiskLevel;
  action?: AgentAction;
  actions?: AgentAction[];
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

export interface DomElementInfo {
  id: string;
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
  isDisabled: boolean;
  isSensitive: boolean;
}

export interface PageObservation {
  url: string;
  title: string;
  text: string;
  elements: DomElementInfo[];
  viewport?: PageViewportInfo;
  frames?: PageFrameInfo[];
}

export interface PageViewportInfo {
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
  timestamp: number;
}

export interface SafetyDecision {
  allowed: boolean;
  riskLevel: RiskLevel;
  reason: string;
}

export type SidePanelToBackgroundMessage =
  | { type: "SIDEPANEL_RUN_TASK"; task: string }
  | { type: "SIDEPANEL_STOP_TASK" }
  | { type: "SIDEPANEL_GET_STATE" };

export type BackgroundToSidePanelMessage =
  | { type: "AGENT_LOG"; entry: AgentLogEntry }
  | { type: "AGENT_STATUS"; running: boolean; taskId?: string }
  | { type: "USAGE_UPDATE"; usage: AgentUsageSnapshot };

export type BackgroundToContentMessage =
  | { type: "CONTENT_OBSERVE" }
  | { type: "CONTENT_EXECUTE"; action: AgentAction };

export type ContentToBackgroundResponse = PageObservation | ContentActionResult;
