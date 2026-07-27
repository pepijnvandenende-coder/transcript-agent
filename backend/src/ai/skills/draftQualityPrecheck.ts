import { readFileSync } from "node:fs";
import path from "node:path";
import type { DraftQualityPrecheckEnvelope, DraftSection } from "../skillEnvelope";
import type { StructureCheckItem } from "../../approval/reportStructureValidator";
import { getAnthropicClient } from "../anthropicClient";

// Phase 14: replaces the Phase 7 deterministic stub with a real Anthropic
// API call for the two content-judgment checks a deterministic check can
// never make ("are attendees/date/subject correctly carried over from the
// source" and "is the text factually grounded in the transcript") -- see
// docs/phase-14/README.md's "Vastgelegde beslissingen" #2. Stays
// ADVISORY_ONLY (approval/policyResolver.ts never consults this skill's
// confidence for routing), so this never blocks the workflow.
export const SKILL_NAME = "DraftQualityPrecheck";
export const SCHEMA_VERSION = "1.0.0";
export const PROMPT_VERSION = "llm-1";

const MODEL = "claude-opus-5";
const MAX_TOKENS = 1024;

const SYSTEM_PROMPT = readFileSync(path.join(__dirname, "../prompts/draftQualityPrecheck.md"), "utf8");

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    checklist: {
      type: "array",
      items: {
        type: "object",
        properties: {
          item: { type: "string" },
          passed: { type: "boolean" },
        },
        required: ["item", "passed"],
        additionalProperties: false,
      },
    },
    blocking_issues: { type: "array", items: { type: "string" } },
    recommendation: { type: "string" },
  },
  required: ["checklist", "blocking_issues", "recommendation"],
  additionalProperties: false,
} as const;

interface DraftQualityPrecheckLlmOutput {
  checklist: Array<{ item: string; passed: boolean }>;
  blocking_issues: string[];
  recommendation: string;
}

function scoreOf(checklist: Array<{ passed: boolean }>): number {
  return checklist.length === 0 ? 0 : checklist.filter((entry) => entry.passed).length / checklist.length;
}

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

  const structuralFailures = structuralItems.filter((item) => !item.passed);

  // Per the plan: the LLM only judges content once the structural precheck
  // passes -- there's nothing meaningful to say about "are attendees
  // correctly carried over" if the draft is structurally broken.
  if (structuralFailures.length > 0) {
    const checklist = structuralItems;
    const blockingIssues = structuralFailures.map((item) => `Ontbrekend of leeg verplicht onderdeel: ${item.item}`);
    return {
      skill: SKILL_NAME,
      schema_version: SCHEMA_VERSION,
      confidence: scoreOf(checklist),
      rationale: "Structurele voorcontrole niet geslaagd -- inhoudelijke LLM-beoordeling overgeslagen.",
      flags: [],
      result: {
        overall_score: scoreOf(checklist),
        checklist,
        blocking_issues: blockingIssues,
        recommendation: "Conceptverslag mist verplichte onderdelen -- menselijke review moet dit eerst beoordelen.",
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
      : { checklist: [], blocking_issues: [], recommendation: "Geen beoordeling ontvangen van de AI." };

  const checklist = [...structuralItems, ...parsed.checklist];

  return {
    skill: SKILL_NAME,
    schema_version: SCHEMA_VERSION,
    confidence: scoreOf(checklist),
    rationale: `LLM-beoordeelde inhoudelijke controle (${MODEL}), na geslaagde structurele voorcontrole.`,
    flags: [],
    result: {
      overall_score: scoreOf(checklist),
      checklist,
      blocking_issues: parsed.blocking_issues,
      recommendation: parsed.recommendation,
    },
  };
}
