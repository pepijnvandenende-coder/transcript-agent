import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadReportTypePrompt } from "../../src/ai/prompts/reportTypeLoader";
import { PROMPT_VERSION, run, SCHEMA_VERSION, SKILL_NAME } from "../../src/ai/skills/draftReviser";
import { DraftReviserEnvelopeSchema } from "../../src/ai/skillEnvelope";

// Phase 16: DraftReviser now calls the real Anthropic API (see
// src/ai/skills/draftReviser.ts), replacing the Phase 8 stub that only ever
// appended feedback verbatim onto a hardcoded "Notulen" section. Mocked here
// the same way draftGenerator.test.ts mocks it -- these tests exercise prompt
// construction and response parsing, not the real model.
const createMock = vi.fn();
vi.mock("../../src/ai/anthropicClient", () => ({
  getAnthropicClient: () => ({ messages: { create: createMock } }),
}));

function mockLlmResponse(output: {
  sections: Array<{ heading: string; content: string }>;
  changes_applied?: string[];
  unresolved_feedback?: string[];
}) {
  createMock.mockResolvedValue({
    content: [{ type: "text", text: JSON.stringify({ changes_applied: [], unresolved_feedback: [], ...output }) }],
  });
}

describe("draftReviser (real LLM, mocked client)", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  const previousSections = [
    { heading: "Samenvatting", content: "x" },
    { heading: "Notulen", content: "y" },
    {
      heading: "Acties en vervolgstappen",
      content: "Jan neemt actie A voor zich.",
    },
  ];

  const baseParams = {
    mergedContent: "Dit is de samengevoegde inhoud van het gesprek.",
    promptRef: "thematic.md",
    subject: "Werkoverleg",
    previousSections,
    feedbackItems: ["Zet acties en vervolgstappen om naar een tabel"],
  };

  it("returns an envelope that validates against the shared schema", async () => {
    mockLlmResponse({ sections: previousSections });

    const envelope = await run(baseParams);
    const parsed = DraftReviserEnvelopeSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
    expect(envelope.skill).toBe(SKILL_NAME);
    expect(envelope.schema_version).toBe(SCHEMA_VERSION);
    expect(PROMPT_VERSION).toBe("llm-1");
  });

  it("calls the model with the report type policy's own prompt file plus revision instructions as the system prompt", async () => {
    mockLlmResponse({ sections: previousSections });

    await run(baseParams);

    const call = createMock.mock.calls[0][0];
    expect(call.model).toBe("claude-opus-4-8");
    expect(call.system).toContain(loadReportTypePrompt("thematic.md"));
    expect(call.system).toContain("De feedback van de gebruiker heeft voorrang boven het standaardformat");
  });

  it("includes the original source, the current draft, and the feedback in the user message", async () => {
    mockLlmResponse({ sections: previousSections });

    await run(baseParams);

    const userMessage = createMock.mock.calls[0][0].messages[0].content as string;
    expect(userMessage).toContain(baseParams.mergedContent);
    expect(userMessage).toContain("Notulen");
    expect(userMessage).toContain("Jan neemt actie A voor zich.");
    expect(userMessage).toContain("Zet acties en vervolgstappen om naar een tabel");
  });

  // Phase 16 test case 1: "Zet acties en vervolgstappen om naar een tabel" ->
  // a real markdown table, not the old content re-appended verbatim.
  it("turns the Acties en vervolgstappen section into a real markdown table when asked", async () => {
    mockLlmResponse({
      sections: [
        { heading: "Samenvatting", content: "x" },
        { heading: "Notulen", content: "y" },
        {
          heading: "Acties en vervolgstappen",
          content: "| Actie | Verantwoordelijke | Deadline | Status |\n|---|---|---|---|\n| Actie A | Jan |  | Open |",
        },
      ],
      changes_applied: ["Acties en vervolgstappen omgezet naar een tabel."],
    });

    const envelope = await run(baseParams);

    const actions = envelope.result.sections.find((s) => s.heading === "Acties en vervolgstappen");
    expect(actions?.content).toContain("| Actie | Verantwoordelijke | Deadline | Status |");
    expect(actions?.content).toContain("| Actie A | Jan |  | Open |");
  });

  // Phase 16 test case 2: "Verwijder acties en vervolgstappen" -> the section
  // is gone entirely, not left in place with a note appended.
  it("removes a section entirely when the feedback asks for it to be removed", async () => {
    mockLlmResponse({
      sections: [
        { heading: "Samenvatting", content: "x" },
        { heading: "Notulen", content: "y" },
      ],
      changes_applied: ["Acties en vervolgstappen volledig verwijderd."],
    });

    const envelope = await run({ ...baseParams, feedbackItems: ["Verwijder acties en vervolgstappen"] });

    expect(envelope.result.sections.find((s) => s.heading === "Acties en vervolgstappen")).toBeUndefined();
    expect(envelope.result.sections).toHaveLength(2);
  });

  // Phase 16 test case 3: "Voeg geen deadlines toe tenzij genoemd" -> the
  // prompt instructs this, and a compliant model response leaves the field
  // blank rather than inventing one; this test locks in that the code layer
  // doesn't itself inject or fabricate anything into that cell.
  it("does not fabricate a deadline -- an empty deadline cell from the model passes through unchanged", async () => {
    mockLlmResponse({
      sections: [
        {
          heading: "Acties en vervolgstappen",
          content: "| Actie | Verantwoordelijke | Deadline | Status |\n|---|---|---|---|\n| Actie A | Jan |  | Open |",
        },
      ],
    });

    const envelope = await run({ ...baseParams, feedbackItems: ["Voeg geen deadlines toe tenzij genoemd"] });

    const actions = envelope.result.sections.find((s) => s.heading === "Acties en vervolgstappen");
    expect(actions?.content).not.toMatch(/\d{1,2}\s+(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)/i);
  });

  it("passes through changes_applied and unresolved_feedback from the model", async () => {
    mockLlmResponse({
      sections: previousSections,
      changes_applied: ["Iets aangepast."],
      unresolved_feedback: ["Kon dit punt niet vinden in het verslag."],
    });

    const envelope = await run(baseParams);

    expect(envelope.result.changes_applied).toEqual(["Iets aangepast."]);
    expect(envelope.result.unresolved_feedback).toEqual(["Kon dit punt niet vinden in het verslag."]);
  });

  it("has a fixed high confidence, since DraftReviser is a MANDATORY skill where confidence is never consulted", async () => {
    mockLlmResponse({ sections: previousSections });

    const envelope = await run(baseParams);

    expect(envelope.confidence).toBe(1);
  });

  it("normalizes inline bullet-separated content the same way DraftGenerator does", async () => {
    mockLlmResponse({
      sections: [{ heading: "Samenvatting", content: "• Eerste punt • Tweede punt" }],
    });

    const envelope = await run(baseParams);

    expect(envelope.result.sections[0].content).toBe("• Eerste punt\n• Tweede punt");
  });
});
