import type { AgentAction } from "../shared/types";

export interface DomStabilityProgress {
  signature?: string;
  stableSamples: number;
  matched: boolean;
}

export interface DomSettlementSample {
  signature: string;
  readyState: DocumentReadyState;
}

export interface DomSettlementResult {
  settled: boolean;
  cancelled: boolean;
  sampleCount: number;
}

interface DomSettlementOptions {
  sampleIntervalMs: number;
  requiredStableSamples: number;
  minimumSamples: number;
  maximumSamples: number;
}

const DEFAULT_SETTLEMENT_OPTIONS: DomSettlementOptions = {
  sampleIntervalMs: 200,
  requiredStableSamples: 3,
  minimumSamples: 4,
  maximumSamples: 15,
};

const AUTO_SETTLE_ACTION_TYPES = new Set<AgentAction["type"]>([
  "click",
  "multi_click",
  "drag",
  "multi_drag",
  "upload_file",
  "fill",
  "type",
  "select",
  "press_key",
  "scroll",
]);

export function advanceDomStability(
  previousSignature: string | undefined,
  stableSamples: number,
  nextSignature: string,
  readyState: DocumentReadyState,
  requiredSamples: number,
): DomStabilityProgress {
  const nextSamples = readyState === "complete" && nextSignature === previousSignature
    ? stableSamples + 1
    : 1;
  return {
    signature: nextSignature,
    stableSamples: nextSamples,
    matched: readyState === "complete" && nextSamples >= requiredSamples,
  };
}

export function needsAutomaticDomSettlement(actions: AgentAction[]): boolean {
  return actions.some((action) => AUTO_SETTLE_ACTION_TYPES.has(action.type));
}

export async function waitForDomSettlement(
  readSample: () => Promise<DomSettlementSample | undefined>,
  pause: (milliseconds: number) => Promise<void>,
  isCancelled: () => boolean,
  options: Partial<DomSettlementOptions> = {},
): Promise<DomSettlementResult> {
  const config = { ...DEFAULT_SETTLEMENT_OPTIONS, ...options };
  let previousSignature: string | undefined;
  let stableSamples = 0;

  for (let sampleCount = 1; sampleCount <= config.maximumSamples; sampleCount += 1) {
    if (isCancelled()) {
      return { settled: false, cancelled: true, sampleCount: sampleCount - 1 };
    }

    await pause(config.sampleIntervalMs);
    if (isCancelled()) {
      return { settled: false, cancelled: true, sampleCount: sampleCount - 1 };
    }

    const sample = await readSample();
    if (!sample) {
      previousSignature = undefined;
      stableSamples = 0;
      continue;
    }

    const progress = advanceDomStability(
      previousSignature,
      stableSamples,
      sample.signature,
      sample.readyState,
      config.requiredStableSamples,
    );
    previousSignature = progress.signature;
    stableSamples = progress.stableSamples;

    if (sampleCount >= config.minimumSamples && progress.matched) {
      return { settled: true, cancelled: false, sampleCount };
    }
  }

  return {
    settled: false,
    cancelled: false,
    sampleCount: config.maximumSamples,
  };
}
