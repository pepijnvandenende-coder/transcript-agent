export interface ConfidenceBreakdown {
  llmSelfReported: number;
  structuralScore: number;
  confidence: number;
}

// confidence = clamp(0.7 * llm_self_reported + 0.3 * structural_score), per
// the architecture doc. structural_score is a fixed stub value in Phase 2 --
// there is no real structural analysis yet, only a stubbed skill output to
// score against it.
const STUB_STRUCTURAL_SCORE = 0.85;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function computeConfidence(llmSelfReported: number): ConfidenceBreakdown {
  const structuralScore = STUB_STRUCTURAL_SCORE;
  const confidence = clamp(0.7 * llmSelfReported + 0.3 * structuralScore, 0, 1);
  return { llmSelfReported, structuralScore, confidence };
}
