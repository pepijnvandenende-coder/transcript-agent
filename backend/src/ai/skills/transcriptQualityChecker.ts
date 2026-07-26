import type { TranscriptQualityEnvelope } from "../skillEnvelope";

// Phase 2 locked decision: this skill is stubbed, not a real LLM call. It
// returns a deterministic envelope shaped exactly like the real skill will,
// so the Gateway's schema validation, confidence scoring, and policy
// resolution can be built and tested against it now.
export const SKILL_NAME = "TranscriptQualityChecker";
export const SCHEMA_VERSION = "1.0.0";
export const PROMPT_VERSION = "stub-1";

export function run(transcriptContent: string): TranscriptQualityEnvelope {
  const wordCount = transcriptContent.trim().split(/\s+/).filter(Boolean).length;
  const sufficient = wordCount > 0;

  return {
    skill: SKILL_NAME,
    schema_version: SCHEMA_VERSION,
    confidence: sufficient ? 0.9 : 0.95,
    rationale: sufficient
      ? "Stubbed TranscriptQualityChecker output for Phase 2: transcript has content."
      : "Stubbed TranscriptQualityChecker output for Phase 2: transcript is empty.",
    flags: [],
    result: {
      sufficient,
      issues: sufficient ? [] : ["transcript_empty"],
      metrics: { word_count: wordCount },
    },
  };
}
