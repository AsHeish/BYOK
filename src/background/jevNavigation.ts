import type { AgentModelResponse, JevSettings, JevUsageSnapshot, PageObservation } from "../shared/types";
import { JevDecisionError, requestJevDecision, type JevDecision } from "./jevClient";
import { ModelRequestCancelledError, type ModelRequestTransport } from "./modelClient";

const MIN_CONFIDENCE = 0.95;
const MAX_CANDIDATES = 40;
const PUBLIC_CONTENT_PATH = /^\/(?:docs?|documentation|wiki|articles?|blog|guides?|help|learn|reference|tutorials?)\//i;
const SENSITIVE_ROUTE = /(?:^|[^a-z])(?:logout|delete|remove|unsubscribe|signout|sign-out|signin|sign-in|auth|login|checkout|purchase|payment|billing|settings|account|admin|token|secret|password|download|export|submit|send|save|edit|update|create|confirm|approve|reject|transfer|pay|buy|order|cart|subscribe|register|reset|revoke|enable|disable|execute)(?:[^a-z]|$)/i;

interface NavigationCandidate {
  id: string;
  url: string;
  label: string;
}

export interface JevNavigationResult {
  response?: AgentModelResponse;
  selectedUrl?: string;
  decision?: JevDecision;
  outcome?: "fast" | "shadow" | "fallback";
  elapsedMs?: number;
  disableForRun?: boolean;
  message: string;
}

export function getJevNavigationGoal(response: AgentModelResponse): string | undefined {
  const actions = response.actions || (response.action ? [response.action] : []);
  const goal = response.navigationGoal?.trim();
  return response.mode === "browser" && response.risk_level === "low" && goal && goal.length <= 500
    && actions.length === 1 && (actions[0].type === "navigate" || actions[0].type === "open_tab")
    ? goal : undefined;
}

export function getJevCandidates(observation: PageObservation, visitedUrls: ReadonlySet<string>): NavigationCandidate[] {
  const page = publicContentUrl(observation.url);
  if (!page) {
    return [];
  }
  const candidates: NavigationCandidate[] = [];
  const seen = new Set([page.href, ...visitedUrls]);
  for (const element of observation.elements) {
    if (element.tag.toLowerCase() !== "a" || element.isDisabled || element.isSensitive || element.frameContext || !element.href) {
      continue;
    }
    const url = publicContentUrl(element.href, page.href);
    const label = (element.label || element.text || "").trim().slice(0, 180);
    if (!url || url.origin !== page.origin || !label || SENSITIVE_ROUTE.test(label) || seen.has(url.href)) {
      continue;
    }
    seen.add(url.href);
    candidates.push({ id: `link_${candidates.length + 1}`, url: url.href, label });
    if (candidates.length === MAX_CANDIDATES) {
      break;
    }
  }
  return candidates;
}

export async function tryJevNavigation(args: {
  settings?: JevSettings;
  goal?: string;
  observation: PageObservation;
  visitedUrls: ReadonlySet<string>;
  signal: AbortSignal;
  transport: ModelRequestTransport;
  readObservation: () => Promise<PageObservation>;
}): Promise<JevNavigationResult> {
  if (args.signal.aborted) {
    throw new ModelRequestCancelledError();
  }
  const goal = args.goal?.trim();
  if (!args.settings || (args.settings.mode !== "fast" && args.settings.mode !== "shadow") || !args.settings.apiKey.trim() || !goal || goal.length > 500) {
    return { message: "Jev is not eligible for this step." };
  }
  const candidates = getJevCandidates(args.observation, args.visitedUrls);
  if (!candidates.length) {
    return { message: "No eligible public-content links for Jev." };
  }
  let decision: JevDecision | undefined;
  try {
    decision = await requestJevDecision({
      apiKey: args.settings.apiKey,
      signal: args.signal,
      state: { goal, url: args.observation.url, title: args.observation.title.slice(0, 200) },
      criteria: Object.fromEntries([
        ["fallback", "Do not navigate. Return control to the planner, including when the goal is already reached."],
        ...candidates.map((candidate) => [candidate.id, `${candidate.label} (${candidate.url})`]),
      ]),
    }, args.transport);
    const selected = candidates.find((candidate) => candidate.id === decision?.choice);
    if (!selected || decision.confidence < MIN_CONFIDENCE) {
      return { decision, outcome: "fallback", message: "Jev deferred to the LLM planner." };
    }
    if (args.settings.mode === "shadow") {
      return { decision, selectedUrl: selected.url, outcome: "shadow", message: "Jev shadow decision recorded; the LLM remains in control." };
    }
    const fresh = await args.readObservation();
    if (args.signal.aborted) {
      throw new ModelRequestCancelledError();
    }
    if (observationSignature(fresh) !== observationSignature(args.observation)
      || !getJevCandidates(fresh, args.visitedUrls).some((candidate) => candidate.url === selected.url)) {
      return { decision, outcome: "fallback", message: "The page changed during the Jev request; using the LLM planner." };
    }
    return {
      decision,
      selectedUrl: selected.url,
      outcome: "fast",
      message: "Jev selected a public-content link; skipped one LLM call.",
      response: {
        mode: "browser",
        risk_level: "low",
        thought_summary: "Following the planner's navigation goal with Jev.",
        action: { type: "navigate", url: selected.url },
      },
    };
  } catch (error) {
    if (args.signal.aborted || error instanceof ModelRequestCancelledError) {
      throw new ModelRequestCancelledError();
    }
    return {
      decision,
      outcome: "fallback",
      elapsedMs: error instanceof JevDecisionError ? error.elapsedMs : undefined,
      disableForRun: true,
      message: `${error instanceof JevDecisionError ? error.message : "Jev page revalidation failed."} Jev is disabled for this run; using the LLM planner.`,
    };
  }
}

export function addJevUsage(previous: JevUsageSnapshot | undefined, result: JevNavigationResult): JevUsageSnapshot | undefined {
  if (!result.outcome) {
    return previous;
  }
  const inputTokens = result.decision?.inputTokens || 0;
  return {
    requests: (previous?.requests || 0) + 1,
    helperRequests: previous?.helperRequests,
    lastDecision: previous?.lastDecision,
    fastDecisions: (previous?.fastDecisions || 0) + Number(result.outcome === "fast"),
    shadowDecisions: (previous?.shadowDecisions || 0) + Number(result.outcome === "shadow"),
    fallbacks: (previous?.fallbacks || 0) + Number(result.outcome === "fallback"),
    inputTokens: (previous?.inputTokens || 0) + inputTokens,
    outputTokens: (previous?.outputTokens || 0) + (result.decision?.outputTokens || 0),
    totalLatencyMs: (previous?.totalLatencyMs || 0) + (result.decision?.elapsedMs ?? result.elapsedMs ?? 0),
    estimatedCostUsd: (previous?.estimatedCostUsd || 0) + inputTokens * 0.042 / 1_000_000,
  };
}

function publicContentUrl(value: string, base?: string): URL | undefined {
  try {
    const url = new URL(value, base);
    const path = decodeURIComponent(url.pathname);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
      || !PUBLIC_CONTENT_PATH.test(path) || SENSITIVE_ROUTE.test(path)
      || /\.(?!html?$)[a-z0-9]+$/i.test(path) || /[%\\]/.test(path)) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function observationSignature(observation: PageObservation): string {
  return JSON.stringify([observation.url, observation.title, observation.text, observation.elements]);
}