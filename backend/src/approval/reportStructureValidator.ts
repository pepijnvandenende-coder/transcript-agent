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

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

function isNonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

// Content-based, not heading-based, per the instruction "gebruik geen
// letterlijke controle op het woord 'Notulen' voor vraag & antwoord" -- a
// section qualifies as a Q&A pair by what it says, not what it's called.
function isQaPair(content: string): boolean {
  return /vraag/i.test(content) && /antwoord/i.test(content);
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

  const rule = policy.bodyContentRule as BodyContentRule | undefined;
  if (rule?.type === "topic_sections") {
    items.push({ item: "Thematische notulen", passed: bodySections.length >= rule.minCount });
  } else if (rule?.type === "qa_pairs") {
    const qaSections = bodySections.filter((section) => isQaPair(section.content));
    items.push({ item: "Vraag/antwoord-secties", passed: qaSections.length >= rule.minCount });
  }

  return items;
}

// The blocking gate DraftGenerator's output must pass (additionalValidation
// in approval/gateway.ts's handleSkillOutput) before it's accepted as
// schema-valid.
export function validateDraftStructure(
  draft: DraftStructureInput,
  policy: ReportTypeValidationPolicy,
): SchemaCheckResult {
  const failed = checkDraftStructure(draft, policy).filter((item) => !item.passed);
  if (failed.length > 0) {
    return { valid: false, errors: failed.map((item) => `Missing or empty required part: ${item.item}`) };
  }
  return { valid: true };
}
