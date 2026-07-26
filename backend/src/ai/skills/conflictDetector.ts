import type { ConflictDetectorEnvelope } from "../skillEnvelope";

// Phase 4 locked decision: stubbed, not a real LLM call, same pattern as
// transcriptQualityChecker.ts / merger.ts. Deterministic: treats each entry
// in the latest Merger output's unmatched_notes as a conflict signal -- notes
// that didn't merge cleanly into the transcript are exactly the kind of
// signal a real ConflictDetector would flag for human review. Confidence is
// fixed at 0.9 in both branches (same documented-gap pattern as
// TranscriptQualityChecker's stub) -- reaching the "no conflicts, low
// confidence" checkpoint live requires a temporary policy edit, same as
// Phase 2's own manual-verification checklist already established.
export const SKILL_NAME = "ConflictDetector";
export const SCHEMA_VERSION = "1.0.0";
export const PROMPT_VERSION = "stub-1";

export function run(unmatchedNotes: string[]): ConflictDetectorEnvelope {
  const hasConflicts = unmatchedNotes.length > 0;

  return {
    skill: SKILL_NAME,
    schema_version: SCHEMA_VERSION,
    confidence: 0.9,
    rationale: hasConflicts
      ? "Stubbed ConflictDetector output for Phase 4: unmatched notes indicate unresolved conflicts."
      : "Stubbed ConflictDetector output for Phase 4: no unmatched notes, no conflicts detected.",
    flags: [],
    result: {
      conflicts: unmatchedNotes.map((note) => ({
        description: `Unmatched note content did not merge cleanly into the transcript: "${note}"`,
        source_b: note,
      })),
    },
  };
}
