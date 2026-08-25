import type { OpenQuestionsEnvelope } from "../skillEnvelope";
import { getAnthropicClient } from "../anthropicClient";
import { loadPostProcessingPrompt } from "../prompts/postProcessingPromptLoader";

// Phase 18: the first of the two example post-processing follow-up skills --
// a real Anthropic call, same pattern as ai/skills/reportTypeAdvisor.ts.
export const SKILL_NAME = "OpenQuestionsAnalyzer";
export const SCHEMA_VERSION = "1.0.0";
export const PROMPT_VERSION = "llm-1";

const MODEL = "claude-opus-5";
const MAX_TOKENS = 2048;

const SYSTEM_PROMPT = loadPostProcessingPrompt("openQuestions.md");

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    open_questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          explanation: { type: "string" },
        },
        required: ["question", "explanation"],
        additionalProperties: false,
      },
    },
  },
  required: ["open_questions"],
  additionalProperties: false,
} as const;

interface OpenQuestionsLlmOutput {
  open_questions: Array<{ question: string; explanation: string }>;
}

export async function run(params: { reportContent: string }): Promise<OpenQuestionsEnvelope> {
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    messages: [
      {
        role: "user",
        content: `Gespreksverslag:\n\n${params.reportContent}`,
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const parsed: OpenQuestionsLlmOutput =
    textBlock && textBlock.type === "text" ? JSON.parse(textBlock.text) : { open_questions: [] };

  return {
    skill: SKILL_NAME,
    schema_version: SCHEMA_VERSION,
    confidence: 1,
    rationale: `LLM-generated OpenQuestionsAnalyzer output (${MODEL}).`,
    flags: [],
    result: { open_questions: parsed.open_questions },
  };
}
