import type { ReportTypeAdvisorEnvelope } from "../skillEnvelope";

// Phase 5 locked decision: stubbed, not a real LLM call, same pattern as
// transcriptQualityChecker.ts / merger.ts / conflictDetector.ts. Deterministic:
// a simple keyword check on the merged content picks between two placeholder
// categories -- there is no real report-type taxonomy specified anywhere in
// the architecture doc, so these names are placeholder data for a stub with
// no LLM behind it yet, not a product decision. Confidence is fixed and
// unused for routing -- ReportTypeAdvisor's policy is MANDATORY
// unconditionally (see approval/gateway.ts's mandatoryReview shape), so the
// confidence score here is stored for the governance record only.
export const SKILL_NAME = "ReportTypeAdvisor";
export const SCHEMA_VERSION = "1.0.0";
export const PROMPT_VERSION = "stub-1";

const INCIDENT_TYPE = "Incident Report";
const STANDARD_TYPE = "Standard Audit Summary";

export function run(mergedContent: string): ReportTypeAdvisorEnvelope {
  const looksLikeIncident = /incident/i.test(mergedContent);
  const suggestedType = looksLikeIncident ? INCIDENT_TYPE : STANDARD_TYPE;
  const runnerUp = looksLikeIncident ? STANDARD_TYPE : INCIDENT_TYPE;

  return {
    skill: SKILL_NAME,
    schema_version: SCHEMA_VERSION,
    confidence: 0.85,
    rationale: looksLikeIncident
      ? "Stubbed ReportTypeAdvisor output for Phase 5: merged content mentions an incident."
      : "Stubbed ReportTypeAdvisor output for Phase 5: no incident-specific signal found, defaulting to a standard summary.",
    flags: [],
    result: {
      suggested_type: suggestedType,
      rationale: looksLikeIncident
        ? "The merged content references an incident, suggesting an incident-focused report."
        : "No incident-specific signal was found in the merged content.",
      runner_up: runnerUp,
    },
  };
}
