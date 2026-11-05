import type { JevTraceEntry } from "../shared/types";
import type { JevActionDecision } from "./jevActions";

export const MAX_JEV_TRACE_ENTRIES = 200;

// Query strings and fragments can carry tokens, so only origin and path are kept.
export function redactTraceUrl(value: string | undefined): string {
  try {
    const url = new URL(value || "");
    return `${url.origin}${url.pathname}`.slice(0, 300);
  } catch {
    return "";
  }
}

export function createJevTraceEntry(args: {
  decision: JevActionDecision;
  outcome: JevTraceEntry["outcome"];
  elapsedMs?: number;
  url?: string;
  at: number;
}): JevTraceEntry {
  const { decision } = args;
  const { result } = decision;
  return {
    at: args.at,
    url: redactTraceUrl(args.url),
    kind: decision.kind,
    operation: decision.operation.slice(0, 80),
    outcome: args.outcome,
    reason: decision.reason.slice(0, 300),
    ...(result?.model ? { model: result.model } : {}),
    ...(result?.attempts ? { attempts: result.attempts } : {}),
    ...(result?.elapsedMs !== undefined || args.elapsedMs !== undefined ? { elapsedMs: result?.elapsedMs ?? args.elapsedMs } : {}),
    ...(result?.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
    ...(result?.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
    ...(result?.ignoredAnswers?.length ? { ignoredAnswers: result.ignoredAnswers.map((name) => name.slice(0, 80)) } : {}),
    heads: Object.entries(result?.answers || {}).map(([question, choice]) => ({
      question: question.slice(0, 80),
      choice: choice.choice.slice(0, 80),
      confidence: choice.confidence,
      top: Object.entries(choice.probabilities).sort((first, second) => second[1] - first[1]).slice(0, 3)
        .map(([option, probability]) => ({ option: option.slice(0, 80), probability })),
    })),
  };
}

export function appendJevTrace(trace: JevTraceEntry[], entry: JevTraceEntry): JevTraceEntry[] {
  return [...trace, entry].slice(-MAX_JEV_TRACE_ENTRIES);
}
