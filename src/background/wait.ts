export interface DomStabilityProgress {
  signature?: string;
  stableSamples: number;
  matched: boolean;
}

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
