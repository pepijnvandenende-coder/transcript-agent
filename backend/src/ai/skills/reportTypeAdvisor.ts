import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReportTypeAdvisorEnvelope } from "../skillEnvelope";
import { getAnthropicClient } from "../anthropicClient";

// Phase 13: replaces the Phase 6 heuristic (a bare `mergedContent.includes("?")`
// check, visible to operators as "Er zijn geen vraagtekens gevonden...") with
// a real Anthropic API call, same pattern as ai/skills/draftGenerator.ts
// (Phase 11). Structured outputs constrain the model to one of the caller's
// own active report_type_policies keys -- it can never invent a type that
// isn't in the catalog.
export const SKILL_NAME = "ReportTypeAdvisor";
export const SCHEMA_VERSION = "1.0.0";
export const PROMPT_VERSION = "llm-1";

// Claude Opus 5 per current guidance for new LLM-calling code. DraftGenerator
// (built in Phase 11, before Opus 5's release) still uses claude-opus-4-8 --
// left as-is, out of scope for this change.
const MODEL = "claude-opus-5";
const MAX_TOKENS = 1024;

const SYSTEM_PROMPT = readFileSync(path.join(__dirname, "../prompts/reportTypeClassifier.md"), "utf8");

interface ReportTypePolicyOption {
  key: string;
  displayName: string;
}

interface ReportTypeAdvisorLlmOutput {
  suggested_type: string;
  rationale: string;
  runner_up: string;
}

export async function run(
  mergedContent: string,
  options: { policies: ReportTypePolicyOption[] },
): Promise<ReportTypeAdvisorEnvelope> {
  const { policies } = options;
  const keys = policies.map((policy) => policy.key);

  const outputSchema = {
    type: "object",
    properties: {
      suggested_type: { type: "string", enum: keys },
      rationale: { type: "string" },
      runner_up: { type: "string", enum: keys },
    },
    required: ["suggested_type", "rationale", "runner_up"],
    additionalProperties: false,
  } as const;

  const catalogList = policies.map((policy) => `- ${policy.key}: ${policy.displayName}`).join("\n");

  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: "json_schema", schema: outputSchema } },
    messages: [
      {
        role: "user",
        content: `Beschikbare verslagtypen:\n${catalogList}\n\nSamengevoegde inhoud van het gesprek:\n\n${mergedContent}`,
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const parsed: ReportTypeAdvisorLlmOutput =
    textBlock && textBlock.type === "text"
      ? JSON.parse(textBlock.text)
      : { suggested_type: keys[0], rationale: "Geen voorstel ontvangen van de AI.", runner_up: keys[0] };

  return {
    skill: SKILL_NAME,
    schema_version: SCHEMA_VERSION,
    // ReportTypeAdvisor is a MANDATORY skill (see approval/policyResolver.ts)
    // -- confidence is never consulted for routing, same reasoning as
    // DraftGenerator's fixed value.
    confidence: 1,
    rationale: `LLM-generated ReportTypeAdvisor output (${MODEL}).`,
    flags: [],
    result: {
      suggested_type: parsed.suggested_type,
      rationale: parsed.rationale,
      runner_up: parsed.runner_up,
    },
  };
}
