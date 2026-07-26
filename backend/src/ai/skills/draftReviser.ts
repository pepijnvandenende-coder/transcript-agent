import type { DraftReviserEnvelope, DraftSection } from "../skillEnvelope";

// Phase 8 locked decision: stubbed, not a real LLM call, same pattern as
// every earlier skill. MANDATORY (see approval/policyResolver.ts and
// gateway.ts's DraftReviser SKILL_ROUTING entry) -- structurally identical to
// ReportTypeAdvisor/DraftGenerator's shape (single edge, no
// PENDING_HUMAN_CONFIRMATION fallback). Each feedback item is appended
// verbatim (real, human-authored text, not a fabrication -- per the "no
// assumptions/new facts" rule every stub since Phase 6 has followed) into the
// "Notulen" section's content -- a stub-only placement choice, flagged as an
// assumption; a real LLM would decide per-item where an amendment belongs.
// `unresolved_feedback` always stays empty -- a deterministic stub can't
// genuinely judge whether feedback was *properly* addressed, same honesty
// draftGenerator.ts's own comment already carries about prose quality.
export const SKILL_NAME = "DraftReviser";
export const SCHEMA_VERSION = "1.0.0";
export const PROMPT_VERSION = "stub-1";

const NOTULEN_HEADING = "Notulen";

export function run(params: {
  previousSections: DraftSection[];
  feedbackItems: string[];
}): DraftReviserEnvelope {
  const { previousSections, feedbackItems } = params;

  const amendments = feedbackItems.map(
    (feedback) => `Aanvulling naar aanleiding van reviewer-feedback: ${feedback}`,
  );

  let appliedToNotulen = false;
  const sections = previousSections.map((section) => {
    if (section.heading !== NOTULEN_HEADING || amendments.length === 0) {
      return section;
    }
    appliedToNotulen = true;
    return {
      heading: section.heading,
      content: [section.content, ...amendments].filter((part) => part.trim().length > 0).join("\n\n"),
    };
  });

  // No Notulen section existed to amend (shouldn't happen once
  // requiredSections validation passes, but the stub doesn't invent a new
  // heading if it's missing) -- nothing was applied.
  const changesApplied = appliedToNotulen ? amendments : [];

  return {
    skill: SKILL_NAME,
    schema_version: SCHEMA_VERSION,
    confidence: 0.8,
    rationale: "Stubbed DraftReviser output for Phase 8 -- feedback appended verbatim, no real LLM judgment yet.",
    flags: [],
    result: {
      sections,
      changes_applied: changesApplied,
      unresolved_feedback: [],
    },
  };
}
