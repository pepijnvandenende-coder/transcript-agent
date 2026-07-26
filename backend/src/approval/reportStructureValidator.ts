import type { DraftSection } from "../ai/skillEnvelope";
import type { SchemaCheckResult } from "./schemaValidator";

// Phase 6: confirms every heading in a report_type_policies row's
// requiredSections is present in the generated draft's sections -- the
// structural half of "how Dutch language and structure are enforced"
// (language quality itself is a real-LLM concern, see draftGenerator.ts).
// `optionalSections` are never enforced here, matching the source prompts'
// own "indien van toepassing" (if applicable) framing for those headings.
export function validateRequiredSections(
  sections: DraftSection[],
  policy: { requiredSections: unknown },
): SchemaCheckResult {
  const requiredSections = Array.isArray(policy.requiredSections) ? (policy.requiredSections as string[]) : [];
  const presentHeadings = new Set(sections.map((section) => section.heading));
  const missing = requiredSections.filter((heading) => !presentHeadings.has(heading));

  if (missing.length > 0) {
    return { valid: false, errors: [`Missing required section(s): ${missing.join(", ")}`] };
  }
  return { valid: true };
}
