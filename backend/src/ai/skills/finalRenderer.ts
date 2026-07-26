import type { DraftSection, FinalRendererEnvelope } from "../skillEnvelope";

// Phase 9: the last skill in the pipeline. Per the architecture doc,
// FinalRenderer is "typically template-only, no LLM" -- unlike every earlier
// skill's "stub-1" convention (a placeholder standing in for a future LLM
// call), this one is deliberately versioned "template-1": the doc frames it
// as staying template-only, not as awaiting an eventual LLM upgrade.
export const SKILL_NAME = "FinalRenderer";
export const SCHEMA_VERSION = "1.0.0";
export const PROMPT_VERSION = "template-1";

// Deterministic template: header fields (echoing the approved Draft
// verbatim -- no assumptions/new facts) followed by every section's heading
// and content, unchanged. Separate from run() so the actual rendered content
// is directly testable without going through the trivial envelope.
export function renderContent(params: {
  title: string;
  attendees: string[];
  date: string;
  subject: string;
  sections: DraftSection[];
}): string {
  const { title, attendees, date, subject, sections } = params;
  const header = [
    `Titel: ${title}`,
    `Aanwezige deelnemers: ${attendees.length > 0 ? attendees.join(", ") : "Niet vastgelegd"}`,
    `Datum: ${date}`,
    `Onderwerp: ${subject}`,
  ].join("\n");

  const body = sections.map((section) => `## ${section.heading}\n\n${section.content}`).join("\n\n");

  return `${header}\n\n${body}\n`;
}

export function run(): FinalRendererEnvelope {
  return {
    skill: SKILL_NAME,
    schema_version: SCHEMA_VERSION,
    confidence: 1,
    rationale: "Deterministic template rendering of the approved draft -- no LLM involved.",
    flags: [],
    result: { rendered: true },
  };
}
