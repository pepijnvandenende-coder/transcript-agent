import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadReportTypePrompt } from "../../src/ai/prompts/reportTypeLoader";
import { run, SCHEMA_VERSION, SKILL_NAME } from "../../src/ai/skills/draftGenerator";
import { DraftGeneratorEnvelopeSchema } from "../../src/ai/skillEnvelope";

// Phase 11: DraftGenerator now calls the real Anthropic API (see
// src/ai/skills/draftGenerator.ts and src/ai/anthropicClient.ts) instead of
// the Phase 6 deterministic stub. Per the Phase 11 plan, the Anthropic SDK
// client is mocked here -- these tests exercise prompt construction and
// response parsing, not the real model, keeping the existing "no network
// dependency in tests" convention.
const createMock = vi.fn();
vi.mock("../../src/ai/anthropicClient", () => ({
  getAnthropicClient: () => ({ messages: { create: createMock } }),
}));

function mockLlmResponse(output: { title: string; attendees: string[]; sections: Array<{ heading: string; content: string }> }) {
  createMock.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify(output) }] });
}

describe("draftGenerator (real LLM, mocked client)", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  const baseParams = {
    mergedContent: "Dit is de samengevoegde inhoud van het gesprek.",
    policyKey: "thematic",
    promptRef: "thematic.md",
    subject: "Werkoverleg",
    date: "2026-01-01",
  };

  it("returns an envelope that validates against the shared schema", async () => {
    mockLlmResponse({
      title: "Gespreksverslag Werkoverleg",
      attendees: ["Jan (voorzitter)"],
      sections: [
        { heading: "Samenvatting", content: "Kernpunten." },
        { heading: "Notulen", content: "Details." },
      ],
    });

    const envelope = await run(baseParams);
    const parsed = DraftGeneratorEnvelopeSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
    expect(envelope.skill).toBe(SKILL_NAME);
    expect(envelope.schema_version).toBe(SCHEMA_VERSION);
  });

  it("calls the model with the report type policy's own prompt file as the system prompt", async () => {
    mockLlmResponse({ title: "x", attendees: [], sections: [] });

    await run(baseParams);

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-opus-4-8",
        system: loadReportTypePrompt("thematic.md"),
      }),
    );
  });

  it("includes the subject, date, and merged content in the user message", async () => {
    mockLlmResponse({ title: "x", attendees: [], sections: [] });

    await run(baseParams);

    const call = createMock.mock.calls[0][0];
    const userMessage = call.messages[0].content as string;
    expect(userMessage).toContain(baseParams.subject);
    expect(userMessage).toContain(baseParams.date);
    expect(userMessage).toContain(baseParams.mergedContent);
  });

  it("uses a different prompt file for the qa policy than for thematic", async () => {
    mockLlmResponse({ title: "x", attendees: [], sections: [] });

    await run({ ...baseParams, policyKey: "qa", promptRef: "qa.md" });

    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ system: loadReportTypePrompt("qa.md") }));
  });

  it("parses the model's title, attendees, and sections into the result", async () => {
    mockLlmResponse({
      title: "Gespreksverslag Werkoverleg",
      attendees: ["Jan (voorzitter)", "Marieke"],
      sections: [{ heading: "Samenvatting", content: "Kernpunten." }],
    });

    const envelope = await run(baseParams);

    expect(envelope.result.title).toBe("Gespreksverslag Werkoverleg");
    expect(envelope.result.attendees).toEqual(["Jan (voorzitter)", "Marieke"]);
    expect(envelope.result.sections).toEqual([{ heading: "Samenvatting", content: "Kernpunten." }]);
  });

  it("takes report_type, date, and subject from the workflow/policy, not the model", async () => {
    mockLlmResponse({ title: "iets heel anders", attendees: [], sections: [] });

    const envelope = await run(baseParams);

    expect(envelope.result.report_type).toBe(baseParams.policyKey);
    expect(envelope.result.date).toBe(baseParams.date);
    expect(envelope.result.subject).toBe(baseParams.subject);
  });

  it("has a fixed high confidence, since DraftGenerator is a MANDATORY skill where confidence is never consulted", async () => {
    mockLlmResponse({ title: "x", attendees: [], sections: [] });

    const envelope = await run(baseParams);

    expect(envelope.confidence).toBe(1);
  });

  it("reports zero coverage when there is no merged content", async () => {
    mockLlmResponse({ title: "x", attendees: [], sections: [] });

    const envelope = await run({ ...baseParams, mergedContent: "" });

    expect(envelope.result.coverage).toBe(0);
  });
});
