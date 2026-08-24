import type { DraftSection } from "../ai/skillEnvelope";
import type { SchemaCheckResult } from "./schemaValidator";

// Phase 14: report_type_policies.body_content_rule -- describes how to
// validate the main content of the draft (previously always a literal
// "Notulen" heading, which was wrong for the qa report type; see
// docs/phase-14/README.md Bevinding 2). Catalog-driven: a new report type
// is still one row plus one prompt file, no new branch here.
export type BodyContentRule =
  | { type: "topic_sections"; minCount: number }
  | { type: "qa_pairs"; minCount: number };

export interface DraftStructureInput {
  title: string;
  attendees: unknown;
  date: string;
  subject: string;
  sections: DraftSection[];
}

export interface ReportTypeValidationPolicy {
  requiredSections: unknown;
  optionalSections: unknown;
  bodyContentRule: unknown;
}

export interface StructureCheckItem {
  item: string;
  passed: boolean;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

function isNonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

// Single source of truth for "does this draft structurally fit its report
// type" -- reused by both the blocking DraftGenerator gate
// (validateDraftStructure below) and the non-blocking DraftQualityPrecheck
// checklist (draftQualityPrecheckRunner.ts), so the two never drift apart.
export function checkDraftStructure(
  draft: DraftStructureInput,
  policy: ReportTypeValidationPolicy,
): StructureCheckItem[] {
  const items: StructureCheckItem[] = [
    { item: "Titel", passed: isNonEmpty(draft.title) },
    { item: "Aanwezige deelnemers", passed: Array.isArray(draft.attendees) && draft.attendees.length > 0 },
    { item: "Datum", passed: isNonEmpty(draft.date) },
    { item: "Onderwerp", passed: isNonEmpty(draft.subject) },
  ];

  const requiredSections = asStringArray(policy.requiredSections);
  const optionalSections = asStringArray(policy.optionalSections);
  const contentByHeading = new Map(draft.sections.map((section) => [section.heading, section.content.trim()]));

  for (const heading of requiredSections) {
    items.push({ item: heading, passed: (contentByHeading.get(heading) ?? "").length > 0 });
  }

  // Everything left after the known metadata headings (Samenvatting +
  // optional sections) is the report's actual body content, regardless of
  // what the model chose to head it -- multiple valid heading variants are
  // expected and never checked by name.
  const knownMetaHeadings = new Set([...requiredSections, ...optionalSections]);
  const bodySections = draft.sections.filter(
    (section) => !knownMetaHeadings.has(section.heading) && section.content.trim().length > 0,
  );

  // qa_pairs no longer keyword-matches the section content for "vraag"/
  // "antwoord" -- qa.md never instructs the model to literally write those
  // words in the body (that "Vraag 1:"/"Antwoord:" labeling is reserved for
  // the separate "Openstaande vragen" section), so a naturally-phrased,
  // topic-headed answer produced exactly per prompt was failing this check
  // on wording alone. Both rule types now just count non-empty body
  // sections; the distinct item label is kept for the operator-facing
  // checklist.
  const rule = policy.bodyContentRule as BodyContentRule | undefined;
  if (rule?.type === "topic_sections") {
    items.push({ item: "Thematische notulen", passed: bodySections.length >= rule.minCount });
  } else if (rule?.type === "qa_pairs") {
    items.push({ item: "Vraag/antwoord-secties", passed: bodySections.length >= rule.minCount });
  }

  return items;
}

// Phase 16 item 5: a revision is a deliberate human choice, so a reviewer
// asking DraftReviser to drop or restructure a standard section (e.g.
// "verwijder acties en vervolgstappen omdat dit gesprek alleen informatief
// was") must not be rejected by the same gate that enforces the standard
// format on first generation. `skipContentSections` keeps the basic header
// facts mandatory (a title/date/subject/attendee list is never a stylistic
// choice) while dropping the requiredSections/bodyContentRule checks, which
// only make sense when the draft is still expected to follow the catalog's
// default shape.
const HEADER_ITEMS = new Set(["Titel", "Aanwezige deelnemers", "Datum", "Onderwerp"]);

// The blocking gate DraftGenerator's (and, in relaxed form, DraftReviser's)
// output must pass (additionalValidation in approval/gateway.ts's
// handleSkillOutput) before it's accepted as schema-valid.
export function validateDraftStructure(
  draft: DraftStructureInput,
  policy: ReportTypeValidationPolicy,
  options?: { skipContentSections?: boolean },
): SchemaCheckResult {
  const items = checkDraftStructure(draft, policy);
  const relevant = options?.skipContentSections ? items.filter((item) => HEADER_ITEMS.has(item.item)) : items;
  const failed = relevant.filter((item) => !item.passed);
  if (failed.length > 0) {
    return { valid: false, errors: failed.map((item) => `Missing or empty required part: ${item.item}`) };
  }
  return { valid: true };
}
