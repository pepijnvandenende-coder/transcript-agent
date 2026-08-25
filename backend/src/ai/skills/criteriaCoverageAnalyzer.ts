import type { CriteriaCoverageEnvelope } from "../skillEnvelope";
import { getAnthropicClient } from "../anthropicClient";
import { loadPostProcessingPrompt } from "../prompts/postProcessingPromptLoader";

// Phase 18: the second example post-processing follow-up skill. Only ever
// invoked when a "normenkader" context_items row exists for the workflow --
// see jobs/runners/postProcessingRunner.ts, which resolves `criteriaContent`
// before calling this.
export const SKILL_NAME = "CriteriaCoverageAnalyzer";
export const SCHEMA_VERSION = "1.0.0";
export const PROMPT_VERSION = "llm-1";

const MODEL = "claude-opus-5";
const MAX_TOKENS = 2048;

const SYSTEM_PROMPT = loadPostProcessingPrompt("criteriaCoverage.md");

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          criterion: { type: "string" },
          status: { type: "string", enum: ["covered", "partially_covered", "not_covered"] },
          explanation: { type: "string" },
        },
        required: ["criterion", "status", "explanation"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
} as const;

interface CriteriaCoverageLlmOutput {
  items: Array<{ criterion: string; status: "covered" | "partially_covered" | "not_covered"; explanation: string }>;
}

export async function run(params: {
  reportContent: string;
  criteriaContent: string;
}): Promise<CriteriaCoverageEnvelope> {
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    messages: [
      {
        role: "user",
        content: `Normenkader:\n\n${params.criteriaContent}\n\nGespreksverslag:\n\n${params.reportContent}`,
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const parsed: CriteriaCoverageLlmOutput =
    textBlock && textBlock.type === "text" ? JSON.parse(textBlock.text) : { items: [] };

  return {
    skill: SKILL_NAME,
    schema_version: SCHEMA_VERSION,
    confidence: 1,
    rationale: `LLM-generated CriteriaCoverageAnalyzer output (${MODEL}).`,
    flags: [],
    result: { items: parsed.items },
  };
}
