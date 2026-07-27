import type { DraftGeneratorEnvelope } from "../skillEnvelope";
import { getAnthropicClient } from "../anthropicClient";
import { loadReportTypePrompt } from "../prompts/reportTypeLoader";

// Phase 11: replaces the Phase 6 deterministic stub with a real Anthropic
// API call, per the approved Phase 11 plan (feedback item 6). The Dutch
// instruction prompts in ai/prompts/reportTypes/{thematic,qa}.md were
// written for exactly this purpose back in Phase 6 and, per
// prisma/schema.prisma's ReportTypePolicy comment ("no code changes to
// draftGenerator.ts or its runner"), are looked up by `promptRef` rather
// than hardcoded per policy key -- adding a third report type is still just
// one catalog row plus one prompt file.
export const SKILL_NAME = "DraftGenerator";
export const SCHEMA_VERSION = "1.0.0";
export const PROMPT_VERSION = "llm-1";

const MODEL = "claude-opus-4-8";
const MAX_TOKENS = 8000;

// Only title/attendees/sections are asked of the model -- report_type,
// date, and subject are known facts from the workflow/policy, not something
// an LLM should be reconstructing (matches the "no invented facts" framing
// the prompt files themselves already state).
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    attendees: { type: "array", items: { type: "string" } },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          heading: { type: "string" },
          content: { type: "string" },
        },
        required: ["heading", "content"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "attendees", "sections"],
  additionalProperties: false,
} as const;

interface DraftGeneratorLlmOutput {
  title: string;
  attendees: string[];
  sections: Array<{ heading: string; content: string }>;
}

export async function run(params: {
  mergedContent: string;
  policyKey: string;
  promptRef: string;
  subject: string;
  date: string;
}): Promise<DraftGeneratorEnvelope> {
  const { mergedContent, policyKey, promptRef, subject, date } = params;
  const systemPrompt = loadReportTypePrompt(promptRef);

  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    messages: [
      {
        role: "user",
        content: `Onderwerp: ${subject}\nDatum: ${date}\n\nBron (transcript en, indien aanwezig, eigen notities, al samengevoegd):\n\n${mergedContent}`,
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const parsed: DraftGeneratorLlmOutput =
    textBlock && textBlock.type === "text"
      ? JSON.parse(textBlock.text)
      : { title: subject, attendees: [], sections: [] };

  return {
    skill: SKILL_NAME,
    schema_version: SCHEMA_VERSION,
    // DraftGenerator is a MANDATORY skill (see approval/policyResolver.ts) --
    // confidence is never consulted for routing, so a fixed high value is
    // sufficient rather than asking the model to self-report a score that
    // has no effect either way.
    confidence: 1,
    rationale: `LLM-generated DraftGenerator output (${MODEL}), shaped by the "${policyKey}" report type policy.`,
    flags: [],
    result: {
      report_type: policyKey,
      title: parsed.title,
      attendees: parsed.attendees,
      date,
      subject,
      sections: parsed.sections,
      coverage: mergedContent.trim().length > 0 ? 1 : 0,
    },
  };
}
