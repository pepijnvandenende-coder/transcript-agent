import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReportTypeAdvisorEnvelopeSchema } from "../../src/ai/skillEnvelope";
import { run, SCHEMA_VERSION, SKILL_NAME } from "../../src/ai/skills/reportTypeAdvisor";

// Phase 13: replaces the Phase 6 heuristic stub (a bare `.includes("?")`
// check) with a real Anthropic API call, same mocking pattern as
// tests/ai/draftGenerator.test.ts -- prompt construction and response
// parsing are exercised, not the real model.
const createMock = vi.fn();
vi.mock("../../src/ai/anthropicClient", () => ({
  getAnthropicClient: () => ({ messages: { create: createMock } }),
}));

const POLICIES = [
  { key: "thematic", displayName: "Thematisch gespreksverslag" },
  { key: "qa", displayName: "Vraag & antwoord gespreksverslag" },
];

function mockLlmResponse(output: { suggested_type: string; rationale: string; runner_up: string }) {
  createMock.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify(output) }] });
}

describe("reportTypeAdvisor (real LLM, mocked client)", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("returns an envelope that validates against the shared schema", async () => {
    mockLlmResponse({ suggested_type: "qa", rationale: "Bevat vraag-en-antwoordparen.", runner_up: "thematic" });

    const envelope = await run("some merged content", { policies: POLICIES });
    const parsed = ReportTypeAdvisorEnvelopeSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
    expect(envelope.skill).toBe(SKILL_NAME);
    expect(envelope.schema_version).toBe(SCHEMA_VERSION);
  });

  it("constrains the output schema's suggested_type/runner_up enums to the given catalog keys", async () => {
    mockLlmResponse({ suggested_type: "thematic", rationale: "x", runner_up: "qa" });

    await run("content", { policies: POLICIES });

    const call = createMock.mock.calls[0][0];
    const schema = call.output_config.format.schema;
    expect(schema.properties.suggested_type.enum).toEqual(["thematic", "qa"]);
    expect(schema.properties.runner_up.enum).toEqual(["thematic", "qa"]);
  });

  it("includes the catalog and merged content in the user message", async () => {
    mockLlmResponse({ suggested_type: "thematic", rationale: "x", runner_up: "qa" });

    await run("de kern van het gesprek", { policies: POLICIES });

    const call = createMock.mock.calls[0][0];
    const userMessage = call.messages[0].content as string;
    expect(userMessage).toContain("thematic: Thematisch gespreksverslag");
    expect(userMessage).toContain("qa: Vraag & antwoord gespreksverslag");
    expect(userMessage).toContain("de kern van het gesprek");
  });

  it("parses the model's suggested_type, rationale, and runner_up into the result", async () => {
    mockLlmResponse({
      suggested_type: "qa",
      rationale: "De inhoud bestaat vooral uit vragen met antwoorden.",
      runner_up: "thematic",
    });

    const envelope = await run("content", { policies: POLICIES });

    expect(envelope.result.suggested_type).toBe("qa");
    expect(envelope.result.rationale).toBe("De inhoud bestaat vooral uit vragen met antwoorden.");
    expect(envelope.result.runner_up).toBe("thematic");
  });

  it("has a fixed high confidence, since ReportTypeAdvisor is a MANDATORY skill where confidence is never consulted", async () => {
    mockLlmResponse({ suggested_type: "thematic", rationale: "x", runner_up: "qa" });

    const envelope = await run("content", { policies: POLICIES });

    expect(envelope.confidence).toBe(1);
  });
});
