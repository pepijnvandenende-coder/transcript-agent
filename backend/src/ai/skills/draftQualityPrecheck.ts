import { readFileSync } from "node:fs";
import path from "node:path";
import type { DraftQualityPrecheckEnvelope, DraftSection, PrecheckStatus } from "../skillEnvelope";
import type { StructureCheckItem } from "../../approval/reportStructureValidator";
import { getAnthropicClient } from "../anthropicClient";
import { ACTIONS_SECTION_HEADING, DATE_NOT_RECORDED } from "./draftGenerator";

// Phase 14: replaces the Phase 7 deterministic stub with a real Anthropic
// API call for the content-judgment checks a deterministic check can never
// make. Phase 15 item 2: the freeform two-item checklist this produced was
// misleading -- a single bundled "attendees/date/subject" item failed
// (and was shown as "missing") the moment the model doubted just one of the
// three, even when the other two were genuinely correct. Reworked into four
// named boolean judgments merged with the structural check into a fixed
// five-item Dutch checklist, so passing items show up as passing instead of
// being silently absent or bundled into a failing group.
//
// Phase 19 item 1: a bare pass/fail marker left the reviewer guessing what
// "Structuur onvolledig" actually meant, and made "the transcript never
// mentioned this" look identical to "the AI got this wrong". Every item now
// carries a PrecheckStatus (ok/info/warning/problem) plus a concrete `detail`
// string, and the LLM call returns a `reason` alongside each boolean instead
// of one freeform `issues` array, so that reason can be shown directly next
// to the item it explains. Stays ADVISORY_ONLY (approval/policyResolver.ts
// never consults this skill's confidence for routing), so this never blocks
// the workflow.
export const SKILL_NAME = "DraftQualityPrecheck";
export const SCHEMA_VERSION = "1.1.0";
export const PROMPT_VERSION = "llm-3";

const MODEL = "claude-opus-5";
const MAX_TOKENS = 1024;

const SYSTEM_PROMPT = readFileSync(path.join(__dirname, "../prompts/draftQualityPrecheck.md"), "utf8");

const FIELD_JUDGMENT_SCHEMA = {
  type: "object",
  properties: {
    correct: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["correct", "reason"],
  additionalProperties: false,
} as const;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    attendees: FIELD_JUDGMENT_SCHEMA,
    date: FIELD_JUDGMENT_SCHEMA,
    subject: FIELD_JUDGMENT_SCHEMA,
    factually_grounded: {
      type: "object",
      properties: {
        grounded: { type: "boolean" },
        reason: { type: "string" },
      },
      required: ["grounded", "reason"],
      additionalProperties: false,
    },
  },
  required: ["attendees", "date", "subject", "factually_grounded"],
  additionalProperties: false,
} as const;

interface FieldJudgment {
  correct: boolean;
  reason: string;
}

interface DraftQualityPrecheckLlmOutput {
  attendees: FieldJudgment;
  date: FieldJudgment;
  subject: FieldJudgment;
  factually_grounded: { grounded: boolean; reason: string };
}

const NO_LLM_OUTPUT: DraftQualityPrecheckLlmOutput = {
  attendees: { correct: false, reason: "" },
  date: { correct: false, reason: "" },
  subject: { correct: false, reason: "" },
  factually_grounded: { grounded: false, reason: "" },
};

type ChecklistItem = { item: string; status: PrecheckStatus; detail: string };

// `info` items reflect information that simply isn't in the source -- never
// a defect, so they're excluded from both sides of the score, not counted
// as a pass.
function scoreOf(checklist: ChecklistItem[]): number {
  const relevant = checklist.filter((entry) => entry.status !== "info");
  if (relevant.length === 0) return 1;
  return relevant.filter((entry) => entry.status === "ok").length / relevant.length;
}

function structuralItemPassed(items: StructureCheckItem[], label: string): boolean {
  return items.find((item) => item.item === label)?.passed ?? false;
}

// Human-readable reason a given structural item is required, keyed by the
// exact StructureCheckItem label reportStructureValidator.ts produces for
// it. Anything not listed here (a catalog-defined requiredSections heading)
// falls back to a generic-but-still-specific phrase built from its own
// label, so a new report type never needs an entry added here.
const STRUCTURE_ITEM_REASONS: Record<string, string> = {
  Titel: "de titel ontbreekt",
  "Thematische notulen": "er zijn onvoldoende thematische secties gevonden om de indeling compleet te maken",
  "Vraag/antwoord-secties": "er zijn onvoldoende vraag-en-antwoordsecties gevonden om de indeling compleet te maken",
};

function describeMissingStructure(failed: StructureCheckItem[]): string {
  return failed
    .map((item) => STRUCTURE_ITEM_REASONS[item.item] ?? `de sectie '${item.item}' ontbreekt of is leeg`)
    .join("; ");
}

// Present-but-wrong and absent-entirely are different problems for a
// reviewer, and "absent because the source never said" is not a problem at
// all -- each gets its own status/detail rather than a fixed label plus a
// separately-worded reason.
function fieldChecklistItem(params: {
  itemLabel: string;
  present: boolean;
  correct: boolean;
  missingStatus: PrecheckStatus;
  missingDetail: string;
  okDetail: string;
  warningDetail: string;
}): ChecklistItem {
  const { itemLabel, present, correct, missingStatus, missingDetail, okDetail, warningDetail } = params;
  if (!present) return { item: itemLabel, status: missingStatus, detail: missingDetail };
  return correct
    ? { item: itemLabel, status: "ok", detail: okDetail }
    : { item: itemLabel, status: "warning", detail: warningDetail };
}

// Rolled up from every checkDraftStructure() item that isn't already
// surfaced as its own checklist entry (Aanwezige deelnemers/Datum/Onderwerp)
// -- Titel, Samenvatting, and the bodyContentRule item. Shown as one
// "Structuur" line whose `detail` always names exactly what's missing,
// rather than a bare "onvolledig".
const OWN_CHECKLIST_LABELS = new Set(["Aanwezige deelnemers", "Datum", "Onderwerp"]);

function buildStructureItem(structuralItems: StructureCheckItem[]): ChecklistItem {
  const remaining = structuralItems.filter((item) => !OWN_CHECKLIST_LABELS.has(item.item));
  const failed = remaining.filter((item) => !item.passed);
  if (failed.length === 0) {
    return { item: "Structuur", status: "ok", detail: "Structuur voldoet aan het verslagtype." };
  }
  return {
    item: "Structuur",
    status: "warning",
    detail: `De structuur is onvolledig: ${describeMissingStructure(failed)}.`,
  };
}

// Optional (never blocking) per report_type_policies -- only shown when the
// resolved policy actually lists it, so this never becomes a generic warning
// unsupported by the catalog data (Requirement: no unsupported warnings).
function buildActionsItem(params: {
  actionsSectionIsOptional: boolean;
  sections: DraftSection[];
  actionsPresentInSource: boolean;
}): ChecklistItem | null {
  const { actionsSectionIsOptional, sections, actionsPresentInSource } = params;
  if (!actionsSectionIsOptional) return null;

  if (!actionsPresentInSource) {
    return {
      item: ACTIONS_SECTION_HEADING,
      status: "info",
      detail: "Geen concrete acties of vervolgstappen gevonden in het transcript.",
    };
  }

  const sectionPresent = sections.some(
    (section) => section.heading === ACTIONS_SECTION_HEADING && section.content.trim().length > 0,
  );
  if (sectionPresent) {
    return { item: ACTIONS_SECTION_HEADING, status: "ok", detail: "Acties en vervolgstappen correct opgenomen." };
  }
  return {
    item: ACTIONS_SECTION_HEADING,
    status: "warning",
    detail: "De sectie 'Acties en vervolgstappen' ontbreekt, terwijl uit het transcript wel concrete acties naar voren komen.",
  };
}

function buildRecommendation(checklist: ChecklistItem[]): string {
  if (checklist.some((entry) => entry.status === "problem")) {
    return "Beoordeling: Het conceptverslag bevat een probleem en is nog niet klaar voor beoordeling.";
  }
  if (checklist.some((entry) => entry.status === "warning")) {
    return "Beoordeling: Controleer de gemarkeerde punten voordat je het verslag goedkeurt.";
  }
  return "Beoordeling: Het conceptverslag kan worden beoordeeld. Er zijn geen kritieke problemen gevonden.";
}

function attentionDetails(checklist: ChecklistItem[]): string[] {
  return checklist.filter((entry) => entry.status === "warning" || entry.status === "problem").map((entry) => entry.detail);
}

export async function run(params: {
  title: string;
  attendees: string[];
  date: string;
  subject: string;
  sections: DraftSection[];
  sourceText: string;
  structuralItems: StructureCheckItem[];
  optionalSections?: string[];
  // Single source of truth for "does the source contain concrete actions",
  // set by DraftGenerator/DraftReviser (see draftGenerator.ts's
  // ACTIONS_PRESENCE_INSTRUCTIONS and prisma/schema.prisma's
  // Draft.actionsPresent) and passed straight through here -- this skill no
  // longer asks the LLM the same question a second time, which is what used
  // to let the precheck and the drafted section disagree.
  actionsPresentInSource: boolean;
}): Promise<DraftQualityPrecheckEnvelope> {
  const { title, attendees, date, subject, sections, sourceText, structuralItems, optionalSections = [], actionsPresentInSource } = params;

  const attendeesPresent = structuralItemPassed(structuralItems, "Aanwezige deelnemers");
  // "Datum" can structurally pass while still holding the DraftGenerator
  // "not recorded" placeholder (see draftGenerator.ts) -- that's a
  // deliberate non-empty value for the Phase 14 structural gate, but it's
  // not a real, judgeable date for this precheck.
  const datePresent = structuralItemPassed(structuralItems, "Datum") && date !== DATE_NOT_RECORDED;
  const subjectPresent = structuralItemPassed(structuralItems, "Onderwerp");
  const structureItem = buildStructureItem(structuralItems);
  const actionsSectionIsOptional = optionalSections.includes(ACTIONS_SECTION_HEADING);

  // Nothing to meaningfully judge content-wise for a draft with no body at
  // all -- skip the LLM call, report what's already known.
  if (sections.length === 0) {
    const actionsItem = buildActionsItem({ actionsSectionIsOptional, sections, actionsPresentInSource });
    const checklist: ChecklistItem[] = [
      fieldChecklistItem({
        itemLabel: "Deelnemers",
        present: attendeesPresent,
        correct: true,
        missingStatus: "info",
        missingDetail: "Geen deelnemers gevonden in het transcript.",
        okDetail: "Deelnemers correct overgenomen.",
        warningDetail: "",
      }),
      fieldChecklistItem({
        itemLabel: "Datum",
        present: datePresent,
        correct: true,
        missingStatus: "info",
        missingDetail: "Datum is niet vastgelegd in het transcript.",
        okDetail: "Datum correct overgenomen.",
        warningDetail: "",
      }),
      fieldChecklistItem({
        itemLabel: "Onderwerp",
        present: subjectPresent,
        correct: true,
        missingStatus: "warning",
        missingDetail: "Onderwerp ontbreekt -- controleer de workflowgegevens.",
        okDetail: "Onderwerp correct overgenomen.",
        warningDetail: "",
      }),
      structureItem,
      ...(actionsItem ? [actionsItem] : []),
      { item: "Inhoud", status: "problem", detail: "Conceptverslag bevat geen inhoud om te beoordelen." },
    ];
    return {
      skill: SKILL_NAME,
      schema_version: SCHEMA_VERSION,
      confidence: scoreOf(checklist),
      rationale: "Conceptverslag bevat geen inhoudelijke secties -- inhoudelijke LLM-beoordeling overgeslagen.",
      flags: [],
      result: {
        overall_score: scoreOf(checklist),
        checklist,
        blocking_issues: attentionDetails(checklist),
        recommendation: buildRecommendation(checklist),
      },
    };
  }

  const draftText = [
    `Titel: ${title}`,
    `Deelnemers: ${attendees.join(", ")}`,
    `Datum: ${date}`,
    `Onderwerp: ${subject}`,
    "",
    ...sections.map((section) => `${section.heading}\n${section.content}`),
  ].join("\n");

  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    messages: [
      {
        role: "user",
        content: `Conceptverslag:\n\n${draftText}\n\nBrontekst:\n\n${sourceText}`,
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const parsed: DraftQualityPrecheckLlmOutput =
    textBlock && textBlock.type === "text" ? JSON.parse(textBlock.text) : NO_LLM_OUTPUT;

  const actionsItem = buildActionsItem({ actionsSectionIsOptional, sections, actionsPresentInSource });

  const checklist: ChecklistItem[] = [
    fieldChecklistItem({
      itemLabel: "Deelnemers",
      present: attendeesPresent,
      correct: parsed.attendees.correct,
      missingStatus: "info",
      missingDetail: "Geen deelnemers gevonden in het transcript.",
      okDetail: "Deelnemers correct overgenomen.",
      warningDetail: parsed.attendees.reason || "Deelnemers wijken mogelijk af van het transcript -- controleer de namen.",
    }),
    fieldChecklistItem({
      itemLabel: "Datum",
      present: datePresent,
      correct: parsed.date.correct,
      missingStatus: "info",
      missingDetail: "Datum is niet vastgelegd in het transcript.",
      okDetail: "Datum correct overgenomen.",
      warningDetail: parsed.date.reason || "Datum wijkt mogelijk af van het transcript -- controleer de datum.",
    }),
    fieldChecklistItem({
      itemLabel: "Onderwerp",
      present: subjectPresent,
      correct: parsed.subject.correct,
      missingStatus: "warning",
      missingDetail: "Onderwerp ontbreekt -- controleer de workflowgegevens.",
      okDetail: "Onderwerp correct overgenomen.",
      warningDetail: parsed.subject.reason || "Onderwerp wijkt mogelijk af van het transcript -- controleer het onderwerp.",
    }),
    structureItem,
    ...(actionsItem ? [actionsItem] : []),
    {
      item: "Inhoud",
      status: parsed.factually_grounded.grounded ? "ok" : "warning",
      detail: parsed.factually_grounded.grounded
        ? "Inhoud sluit aan op het transcript."
        : parsed.factually_grounded.reason || "Inhoud bevat mogelijk niet-onderbouwde informatie -- controleer dit.",
    },
  ];

  return {
    skill: SKILL_NAME,
    schema_version: SCHEMA_VERSION,
    confidence: scoreOf(checklist),
    rationale: `LLM-beoordeelde inhoudelijke controle (${MODEL}).`,
    flags: [],
    result: {
      overall_score: scoreOf(checklist),
      checklist,
      blocking_issues: attentionDetails(checklist),
      recommendation: buildRecommendation(checklist),
    },
  };
}
