import type { DraftGeneratorEnvelope } from "../skillEnvelope";

// Phase 6 locked decision: stubbed, not a real LLM call, same pattern as
// every earlier skill. Deterministic and content-agnostic in structure
// (which report_type_policy applies decides the "Notulen" framing only) --
// per the "no assumptions/interpretations/new facts" requirement, this stub
// echoes real source data (the merged content excerpt, the workflow's own
// title/date) rather than inventing details. Attendee extraction has no
// source data anywhere in the current model, so it deliberately stays an
// empty array rather than a fabricated placeholder name. Genuine Dutch
// prose quality (fluent B1/B2 language, real per-theme/per-question
// structuring) is inherently a real-LLM concern and is out of scope here --
// see report_type_policies/prompt files for the instructions that will
// govern that once a real LLM is wired in.
export const SKILL_NAME = "DraftGenerator";
export const SCHEMA_VERSION = "1.0.0";
export const PROMPT_VERSION = "stub-1";

const SUMMARY_EXCERPT_LENGTH = 150;
const NOTULEN_EXCERPT_LENGTH = 300;

export function run(params: {
  mergedContent: string;
  policyKey: string;
  subject: string;
  date: string;
}): DraftGeneratorEnvelope {
  const { mergedContent, policyKey, subject, date } = params;
  const trimmed = mergedContent.trim();

  const summaryExcerpt = trimmed.slice(0, SUMMARY_EXCERPT_LENGTH);
  const samenvattingContent =
    summaryExcerpt.length > 0
      ? `Samenvatting op basis van het brondocument: ${summaryExcerpt}${trimmed.length > SUMMARY_EXCERPT_LENGTH ? "..." : ""}`
      : "Geen brontekst beschikbaar voor een samenvatting.";

  const notulenExcerpt = trimmed.slice(0, NOTULEN_EXCERPT_LENGTH);
  const notulenLabel =
    policyKey === "qa"
      ? "Vraag & antwoord (weergave op basis van het brondocument)"
      : "Besproken onderwerpen (weergave op basis van het brondocument)";
  const notulenContent =
    notulenExcerpt.length > 0
      ? `${notulenLabel}:\n\n${notulenExcerpt}${trimmed.length > NOTULEN_EXCERPT_LENGTH ? "..." : ""}`
      : "Geen brontekst beschikbaar voor de notulen.";

  return {
    skill: SKILL_NAME,
    schema_version: SCHEMA_VERSION,
    confidence: 0.8,
    rationale: `Stubbed DraftGenerator output for Phase 6, shaped by the "${policyKey}" report type policy.`,
    flags: [],
    result: {
      report_type: policyKey,
      title: `Gespreksverslag ${subject}`,
      // No attendee data exists anywhere in the current model -- left empty
      // rather than fabricated, per the "no new facts" requirement.
      attendees: [],
      date,
      subject,
      sections: [
        { heading: "Samenvatting", content: samenvattingContent },
        { heading: "Notulen", content: notulenContent },
      ],
      coverage: trimmed.length > 0 ? 0.7 : 0,
    },
  };
}
