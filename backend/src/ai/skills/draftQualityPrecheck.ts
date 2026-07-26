import type { DraftQualityPrecheckEnvelope, DraftSection } from "../skillEnvelope";

// Phase 7 locked decision: stubbed, not a real LLM call, same pattern as
// every earlier skill. ADVISORY_ONLY (see approval/policyResolver.ts and
// gateway.ts's DraftQualityPrecheck SKILL_ROUTING entry) -- this skill never
// gates the FSM, it only annotates. The stub's checklist is purely
// structural (does each required heading exist with non-empty content) --
// genuine content-quality assessment (fluency, factual grounding, tone) is
// inherently a real-LLM concern and stays out of scope, same caveat
// draftGenerator.ts already carries for prose quality.
export const SKILL_NAME = "DraftQualityPrecheck";
export const SCHEMA_VERSION = "1.0.0";
export const PROMPT_VERSION = "stub-1";

export function run(params: {
  sections: DraftSection[];
  requiredSections: string[];
}): DraftQualityPrecheckEnvelope {
  const { sections, requiredSections } = params;
  const contentByHeading = new Map(sections.map((section) => [section.heading, section.content.trim()]));

  const checklist = requiredSections.map((heading) => ({
    item: heading,
    passed: (contentByHeading.get(heading) ?? "").length > 0,
  }));

  const blockingIssues = checklist
    .filter((entry) => !entry.passed)
    .map((entry) => `Missing or empty required section: ${entry.item}`);

  const overallScore = checklist.length === 0 ? 0 : checklist.filter((entry) => entry.passed).length / checklist.length;

  const recommendation =
    blockingIssues.length > 0
      ? "Draft is missing required content -- human review should verify before approval."
      : "Draft appears structurally complete -- human review should confirm content accuracy.";

  return {
    skill: SKILL_NAME,
    schema_version: SCHEMA_VERSION,
    confidence: overallScore,
    rationale: "Deterministic structural precheck (stub -- no real LLM yet).",
    flags: [],
    result: {
      overall_score: overallScore,
      checklist,
      blocking_issues: blockingIssues,
      recommendation,
    },
  };
}
