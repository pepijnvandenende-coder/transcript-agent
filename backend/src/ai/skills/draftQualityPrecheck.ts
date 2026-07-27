import { readFileSync } from "node:fs";
import path from "node:path";
import type { DraftQualityPrecheckEnvelope, DraftSection } from "../skillEnvelope";
import type { StructureCheckItem } from "../../approval/reportStructureValidator";
import { getAnthropicClient } from "../anthropicClient";
import { DATE_NOT_RECORDED } from "./draftGenerator";

// Phase 14: replaces the Phase 7 deterministic stub with a real Anthropic
// API call for the content-judgment checks a deterministic check can never
// make. Phase 15 item 2: the freeform two-item checklist this produced was
// misleading -- a single bundled "attendees/date/subject" item failed
// (and was shown as "missing") the moment the model doubted just one of the
// three, even when the other two were genuinely correct. Reworked into four
// named boolean judgments (schema/code change only -- draftQualityPrecheck.md's
// *substance* is unchanged, only its output-format description) merged with
// the structural check into a fixed five-item Dutch checklist, so passing
// items show up as passing instead of being silently absent or bundled into
// a failing group. Stays ADVISORY_ONLY (approval/policyResolver.ts never
// consults this skill's confidence for routing), so this never blocks the
// workflow.
export const SKILL_NAME = "DraftQualityPrecheck";
export const SCHEMA_VERSION = "1.0.0";
export const PROMPT_VERSION = "llm-2";

const MODEL = "claude-opus-5";
const MAX_TOKENS = 1024;

const SYSTEM_PROMPT = readFileSync(path.join(__dirname, "../prompts/draftQualityPrecheck.md"), "utf8");

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    attendees_correct: { type: "boolean" },
    date_correct: { type: "boolean" },
    subject_correct: { type: "boolean" },
    factually_grounded: { type: "boolean" },
    issues: { type: "array", items: { type: "string" } },
  },
  required: ["attendees_correct", "date_correct", "subject_correct", "factually_grounded", "issues"],
  additionalProperties: false,
} as const;

interface DraftQualityPrecheckLlmOutput {
  attendees_correct: boolean;
  date_correct: boolean;
  subject_correct: boolean;
  factually_grounded: boolean;
  issues: string[];
}

type ChecklistItem = { item: string; passed: boolean };

function scoreOf(checklist: ChecklistItem[]): number {
  return checklist.length === 0 ? 0 : checklist.filter((entry) => entry.passed).length / checklist.length;
}

function structuralItemPassed(items: StructureCheckItem[], label: string): boolean {
  return items.find((item) => item.item === label)?.passed ?? false;
}

// Present-but-wrong and absent-entirely are different problems for a
// reviewer -- the label itself communicates which one it is, rather than a
// fixed label plus a separately-worded reason.
function fieldChecklistItem(
  present: boolean,
  correct: boolean,
  labels: { missing: string; correct: string; incorrect: string },
): ChecklistItem {
  if (!present) return { item: labels.missing, passed: false };
  return correct ? { item: labels.correct, passed: true } : { item: labels.incorrect, passed: false };
}

// Rolled up from every checkDraftStructure() item that isn't already
// surfaced as its own checklist entry (Aanwezige deelnemers/Datum/Onderwerp)
// -- Titel, Samenvatting, and the bodyContentRule item. Shown as one summary
// line rather than exposing every granular structural label.
const OWN_CHECKLIST_LABELS = new Set(["Aanwezige deelnemers", "Datum", "Onderwerp"]);

export async function run(params: {
  title: string;
  attendees: string[];
  date: string;
  subject: string;
  sections: DraftSection[];
  sourceText: string;
  structuralItems: StructureCheckItem[];
}): Promise<DraftQualityPrecheckEnvelope> {
  const { title, attendees, date, subject, sections, sourceText, structuralItems } = params;

  const attendeesPresent = structuralItemPassed(structuralItems, "Aanwezige deelnemers");
  // "Datum" can structurally pass while still holding the DraftGenerator
  // "not recorded" placeholder (see draftGenerator.ts) -- that's a
  // deliberate non-empty value for the Phase 14 structural gate, but it's
  // not a real, judgeable date for this precheck.
  const datePresent = structuralItemPassed(structuralItems, "Datum") && date !== DATE_NOT_RECORDED;
  const subjectPresent = structuralItemPassed(structuralItems, "Onderwerp");

  const remainingStructuralItems = structuralItems.filter((item) => !OWN_CHECKLIST_LABELS.has(item.item));
  const structureOk = remainingStructuralItems.every((item) => item.passed);
  const structureItem: ChecklistItem = { item: structureOk ? "Structuur voldoet" : "Structuur onvolledig", passed: structureOk };

  const presenceIssues = [
    ...(attendeesPresent ? [] : ["Deelnemers ontbreken."]),
    ...(datePresent ? [] : ["Datum ontbreekt."]),
    ...(subjectPresent ? [] : ["Onderwerp ontbreekt."]),
    ...(structureOk ? [] : ["Structuur van het conceptverslag is onvolledig."]),
  ];

  // Nothing to meaningfully judge content-wise for a draft with no body at
  // all -- skip the LLM call, report what's already known.
  if (sections.length === 0) {
    const checklist: ChecklistItem[] = [
      fieldChecklistItem(attendeesPresent, true, {
        missing: "Deelnemers ontbreken",
        correct: "Deelnemers correct overgenomen",
        incorrect: "Deelnemers wijken af van het transcript",
      }),
      fieldChecklistItem(datePresent, true, {
        missing: "Datum ontbreekt",
        correct: "Datum correct overgenomen",
        incorrect: "Datum wijkt af van het transcript",
      }),
      fieldChecklistItem(subjectPresent, true, {
        missing: "Onderwerp ontbreekt",
        correct: "Onderwerp correct overgenomen",
        incorrect: "Onderwerp wijkt af van het transcript",
      }),
      structureItem,
      { item: "Inhoud bevat niet-onderbouwde informatie", passed: false },
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
        blocking_issues: [...presenceIssues, "Conceptverslag bevat geen inhoud om te beoordelen."],
        recommendation: "Conceptverslag is nog niet compleet -- menselijke review moet dit eerst beoordelen.",
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
    textBlock && textBlock.type === "text"
      ? JSON.parse(textBlock.text)
      : { attendees_correct: false, date_correct: false, subject_correct: false, factually_grounded: false, issues: [] };

  const checklist: ChecklistItem[] = [
    fieldChecklistItem(attendeesPresent, parsed.attendees_correct, {
      missing: "Deelnemers ontbreken",
      correct: "Deelnemers correct overgenomen",
      incorrect: "Deelnemers wijken af van het transcript",
    }),
    fieldChecklistItem(datePresent, parsed.date_correct, {
      missing: "Datum ontbreekt",
      correct: "Datum correct overgenomen",
      incorrect: "Datum wijkt af van het transcript",
    }),
    fieldChecklistItem(subjectPresent, parsed.subject_correct, {
      missing: "Onderwerp ontbreekt",
      correct: "Onderwerp correct overgenomen",
      incorrect: "Onderwerp wijkt af van het transcript",
    }),
    structureItem,
    {
      item: parsed.factually_grounded ? "Inhoud sluit aan op het transcript" : "Inhoud bevat niet-onderbouwde informatie",
      passed: parsed.factually_grounded,
    },
  ];

  const blockingIssues = [...presenceIssues, ...parsed.issues];
  const recommendation =
    blockingIssues.length === 0
      ? "Alle controles geslaagd -- geen aandachtspunten gevonden."
      : `${blockingIssues.length} aandachtspunt(en) gevonden -- controleer de checklist voor details.`;

  return {
    skill: SKILL_NAME,
    schema_version: SCHEMA_VERSION,
    confidence: scoreOf(checklist),
    rationale: `LLM-beoordeelde inhoudelijke controle (${MODEL}).`,
    flags: [],
    result: {
      overall_score: scoreOf(checklist),
      checklist,
      blocking_issues: blockingIssues,
      recommendation,
    },
  };
}
