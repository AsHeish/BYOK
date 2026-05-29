import type {
  AgentAction,
  AgentModelResponse,
  DomElementInfo,
  PageObservation,
  SafetyDecision
} from "../shared/types";

const SECURITY_BYPASS_PATTERNS = [
  /captcha|recaptcha|hcaptcha|bot detection/i,
  /bypass|evade|circumvent|disable security/i,
  /paywall|subscription wall/i
];

const CREDENTIAL_THEFT_PATTERNS = [
  /steal|exfiltrate|dump|export.*cookie|cookie.*export/i,
  /reveal.*(password|token|secret|credential|api key|cookie)/i,
  /show.*(password|token|secret|credential|api key|cookie)/i,
  /copy.*(password|token|secret|credential|api key|cookie)/i,
  /hidden.*(password|token|secret|credential|api key)/i,
  /(password|passcode|one-time code|otp|2fa|mfa|token|session id|bearer|secret|credential|api key).*(steal|exfiltrate|dump|export|reveal|show|copy)/i
];

export function validateAgentAction(args: {
  modelResponse: AgentModelResponse;
  task: string;
  observation: PageObservation;
  userConfirmed?: boolean;
}): SafetyDecision {
  const action = args.modelResponse.action;
  const target = action.elementId ? findElement(args.observation, action.elementId) : undefined;
  const combinedText = [
    args.task,
    args.observation.title,
    args.observation.url,
    action.text,
    action.url,
    target?.text,
    target?.label,
    target?.placeholder,
    target?.href
  ]
    .filter(Boolean)
    .join(" ");

  const structuralDecision = validateActionShape(action, target);
  if (!structuralDecision.allowed) {
    return structuralDecision;
  }

  if (matchesAny(combinedText, SECURITY_BYPASS_PATTERNS) || matchesAny(combinedText, CREDENTIAL_THEFT_PATTERNS)) {
    return {
      allowed: false,
      riskLevel: "high",
      reason:
        "This action appears to involve credentials, CAPTCHA/security bypass, paywall bypass, or secret extraction, which the agent will not perform."
    };
  }

  if (target?.isSensitive && (action.type === "type" || action.type === "select")) {
    return {
      allowed: false,
      riskLevel: "high",
      reason: "The target field appears sensitive, so the agent will not type into it."
    };
  }

  return {
    allowed: true,
    riskLevel: args.modelResponse.risk_level,
    reason: "Action passed safety validation."
  };
}

function validateActionShape(action: AgentAction, target?: DomElementInfo): SafetyDecision {
  if (action.type === "done" || action.type === "ask_user" || action.type === "extract") {
    return allowLow();
  }

  if ((action.type === "click" || action.type === "type" || action.type === "select") && !action.elementId) {
    return block("The action requires an elementId.");
  }

  if ((action.type === "click" || action.type === "type" || action.type === "select") && !target) {
    return block("The target element is not available on the current page.");
  }

  if (target?.isDisabled) {
    return block("The target element is disabled.");
  }

  if (action.type === "type" && typeof action.text !== "string") {
    return block("The type action requires text.");
  }

  if (action.type === "select" && typeof action.text !== "string") {
    return block("The select action requires text with the option value or label.");
  }

  if (action.type === "scroll" && !["up", "down", "left", "right"].includes(String(action.direction))) {
    return block("The scroll action requires direction: up, down, left, or right.");
  }

  if (action.type === "navigate") {
    if (!action.url) {
      return block("The navigate action requires a URL.");
    }
    try {
      const parsed = new URL(action.url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return block("The agent can only navigate to http(s) URLs.");
      }
    } catch {
      return block("The navigate action URL is invalid.");
    }
  }

  return allowLow();
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function findElement(observation: PageObservation, elementId: string): DomElementInfo | undefined {
  return observation.elements.find((element) => element.id === elementId);
}

function allowLow(): SafetyDecision {
  return {
    allowed: true,
    riskLevel: "low",
    reason: "Action shape is valid."
  };
}

function block(reason: string): SafetyDecision {
  return {
    allowed: false,
    riskLevel: "high",
    reason
  };
}
