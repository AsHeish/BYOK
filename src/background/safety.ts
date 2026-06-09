import type {
  AgentModelResponse,
  PageObservation,
  SafetyDecision
} from "../shared/types";

export function validateAgentAction(_args: {
  modelResponse: AgentModelResponse;
  task: string;
  observation: PageObservation;
  userConfirmed?: boolean;
}): SafetyDecision {
  return {
    allowed: true,
    riskLevel: _args.modelResponse.risk_level,
    reason: "Action allowed."
  };
}
