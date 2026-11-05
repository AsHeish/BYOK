import type {
  AgentAction,
  AgentModelResponse,
  DomElementInfo,
  PageObservation,
  SafetyDecision
} from "../shared/types";
import { createId } from "../shared/ids";

export function isSafeNavigationUrl(value: string, base?: string): boolean {
  try {
    const url = new URL(value, base);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch { return false; }
}

export function isSafeControl(element: DomElementInfo): boolean {
  return !element.isDisabled;
}

export function guardObservedAction(action: AgentAction, observation: PageObservation, options?: { scoped?: boolean; replaceExisting?: boolean }): AgentAction | undefined {
  if (!observation.documentId) return undefined;
  const ids = [action.elementId, ...(action.elementIds || []), action.targetElementId,
    ...(action.dragPairs || []).flatMap((pair) => [pair.elementId, pair.targetElementId])].filter((id): id is string => Boolean(id));
  const targets: Record<string, string> = {};
  const scopes: Record<string, string> = {};
  for (const id of ids) {
    const element = observation.elements.find((entry) => entry.id === id);
    if (!element?.fingerprint || !isSafeControl(element)) return undefined;
    targets[id] = element.fingerprint;
    if (element.scopeState) scopes[id] = element.scopeState;
  }
  // Only a click or select on controls that report their own group state may skip the page-wide form check; everything else stays strict.
  const scoped = Boolean(options?.scoped) && (action.type === "click" || action.type === "select")
    && ids.length > 0 && ids.every((id) => scopes[id]);
  const replaceExisting = Boolean(options?.replaceExisting) && action.type === "fill"
    && observation.elements.find((entry) => entry.id === action.elementId)?.isSensitive === false;
  const replace = replaceExisting ? { replaceExisting: true } : {};
  return { ...action, guard: scoped
    ? { id: createId("action"), documentId: observation.documentId, url: observation.url, targets, scopes, ...replace }
    : { id: createId("action"), documentId: observation.documentId, formState: observation.formState, url: observation.url, targets, ...replace } };
}

export function validateAgentAction(args: {
  modelResponse: AgentModelResponse;
  task: string;
  observation: PageObservation;
  userConfirmed?: boolean;
}): SafetyDecision {
  const actions = args.modelResponse.actions || (args.modelResponse.action ? [args.modelResponse.action] : []);
  for (const action of actions) {
    const targets = [action.elementId, ...(action.elementIds || []), action.targetElementId,
      ...(action.dragPairs || []).flatMap((pair) => [pair.elementId, pair.targetElementId])].filter(Boolean);
    const unavailable = targets.find((id) => {
      const element = args.observation.elements.find((entry) => entry.id === id);
      return !element || element.isDisabled;
    });
    if (unavailable) {
      return { allowed: false, recoverable: true, riskLevel: args.modelResponse.risk_level,
        reason: `Target ${unavailable} is not currently observed or is disabled. No action was executed. Re-observe and scroll to the required field; do not guess an earlier element ID.` };
    }
    if (["navigate", "open_tab"].includes(action.type) && (!action.url || !isSafeNavigationUrl(action.url, args.observation.url))) {
      return { allowed: false, recoverable: true, riskLevel: args.modelResponse.risk_level,
        reason: "Navigation requires a valid http(s) URL. No action was executed; choose a current page link or correct the URL." };
    }
  }
  return {
    allowed: true,
    riskLevel: args.modelResponse.risk_level,
    reason: "Action allowed."
  };
}
