export type Provider = "openai" | "gemini" | "groq" | "custom";

export interface AgentSettings {
  provider: Provider;
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  maxSteps: number;
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
  createdAt: number;
  updatedAt: number;
}

export type RiskLevel = "low" | "medium" | "high";

export type AgentActionType =
  | "click"
  | "type"
  | "select"
  | "scroll"
  | "navigate"
  | "extract"
  | "ask_user"
  | "done";

export interface AgentAction {
  type: AgentActionType;
  elementId?: string;
  text?: string;
  url?: string;
  direction?: "up" | "down" | "left" | "right";
}

export interface AgentModelResponse {
  thought_summary: string;
  risk_level: RiskLevel;
  action: AgentAction;
}

export interface DomElementInfo {
  id: string;
  tag: string;
  role?: string;
  type?: string;
  text?: string;
  label?: string;
  name?: string;
  placeholder?: string;
  value?: string;
  href?: string;
  options?: string[];
  isDisabled: boolean;
  isSensitive: boolean;
}

export interface PageObservation {
  url: string;
  title: string;
  text: string;
  elements: DomElementInfo[];
}

export interface ContentActionResult {
  ok: boolean;
  message: string;
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
  | { type: "AGENT_STATUS"; running: boolean; taskId?: string };

export type BackgroundToContentMessage =
  | { type: "CONTENT_OBSERVE" }
  | { type: "CONTENT_EXECUTE"; action: AgentAction };

export type ContentToBackgroundResponse = PageObservation | ContentActionResult;
