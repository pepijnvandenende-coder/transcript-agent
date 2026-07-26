import type { MergerEnvelope } from "../skillEnvelope";

// Phase 3 locked decision: stubbed, not a real LLM call, same pattern as
// transcriptQualityChecker.ts. Confidence varies with notes-presence (unlike
// TranscriptQualityChecker's fixed-confidence stub) so both the auto-approve
// and low-confidence Gateway paths are reachable live at the seeded 0.80
// threshold, without a temporary policy edit.
export const SKILL_NAME = "Merger";
export const SCHEMA_VERSION = "1.0.0";
export const PROMPT_VERSION = "stub-1";

const WITH_NOTES_CONFIDENCE = 0.92;
const WITHOUT_NOTES_CONFIDENCE = 0.65;

export function run(transcriptContent: string, notesContent?: string): MergerEnvelope {
  const hasNotes = Boolean(notesContent && notesContent.trim().length > 0);

  const sections = [
    { heading: "Transcript", content: transcriptContent, source: "transcript" as const },
    ...(hasNotes ? [{ heading: "Notes", content: notesContent as string, source: "notes" as const }] : []),
  ];

  return {
    skill: SKILL_NAME,
    schema_version: SCHEMA_VERSION,
    confidence: hasNotes ? WITH_NOTES_CONFIDENCE : WITHOUT_NOTES_CONFIDENCE,
    rationale: hasNotes
      ? "Stubbed Merger output for Phase 3: transcript and notes both merged."
      : "Stubbed Merger output for Phase 3: no notes provided, merged from transcript alone.",
    flags: hasNotes ? [] : ["no_notes_provided"],
    result: {
      merged_sections: sections,
      unmatched_notes: [],
    },
  };
}
