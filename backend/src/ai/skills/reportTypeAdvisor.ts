import type { ReportTypeAdvisorEnvelope } from "../skillEnvelope";

// Phase 6 retrofit: stubbed, not a real LLM call, same pattern as every other
// skill -- deterministic, and stays a PURE function (no DB access) like
// transcriptQualityChecker.ts/merger.ts/conflictDetector.ts. Suggests one of
// the report_type_policies catalog's own Dutch display names rather than the
// old Phase 5 English placeholder pair ("Incident Report"/"Standard Audit
// Summary"), so suggestion -> selection -> drafting is coherent end-to-end.
// The caller (jobs/runners/suggestReportTypeRunner.ts) fetches the catalog
// and passes the two labels in, keeping this module DB-free.
//
// Heuristic: explicit question marks in the merged content suggest a
// question-and-answer-style conversation (the "qa" policy); their absence
// suggests a topic-organized discussion (the "thematic" policy). Confidence
// is fixed and unused for routing -- ReportTypeAdvisor's policy is MANDATORY
// unconditionally (see approval/gateway.ts's bypassEvent shape).
export const SKILL_NAME = "ReportTypeAdvisor";
export const SCHEMA_VERSION = "1.0.0";
export const PROMPT_VERSION = "stub-1";

export function run(
  mergedContent: string,
  options: { thematicLabel: string; qaLabel: string },
): ReportTypeAdvisorEnvelope {
  const looksLikeQA = mergedContent.includes("?");
  const suggestedType = looksLikeQA ? options.qaLabel : options.thematicLabel;
  const runnerUp = looksLikeQA ? options.thematicLabel : options.qaLabel;

  return {
    skill: SKILL_NAME,
    schema_version: SCHEMA_VERSION,
    confidence: 0.85,
    rationale: looksLikeQA
      ? "Stubbed ReportTypeAdvisor output for Phase 6: merged content contains explicit questions, suggesting a Q&A-structured report."
      : "Stubbed ReportTypeAdvisor output for Phase 6: no explicit questions found, suggesting a thematic report.",
    flags: [],
    result: {
      suggested_type: suggestedType,
      rationale: looksLikeQA
        ? "The merged content contains question marks, consistent with a question-and-answer conversation."
        : "No question marks were found in the merged content; a thematic structure fits better.",
      runner_up: runnerUp,
    },
  };
}
