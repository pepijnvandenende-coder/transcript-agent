import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadReportTypePrompt } from "../../src/ai/prompts/reportTypeLoader";
import { DATE_NOT_RECORDED, run, SCHEMA_VERSION, SKILL_NAME } from "../../src/ai/skills/draftGenerator";
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

function mockLlmResponse(output: {
  title: string;
  attendees: string[];
  sections: Array<{ heading: string; content: string }>;
  conversation_date?: string | null;
}) {
  createMock.mockResolvedValue({
    content: [{ type: "text", text: JSON.stringify({ conversation_date: null, ...output }) }],
  });
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

  it("includes the subject and merged content in the user message", async () => {
    mockLlmResponse({ title: "x", attendees: [], sections: [] });

    await run(baseParams);

    const call = createMock.mock.calls[0][0];
    const userMessage = call.messages[0].content as string;
    expect(userMessage).toContain(baseParams.subject);
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

  it("takes report_type and subject from the workflow/policy, not the model", async () => {
    mockLlmResponse({ title: "iets heel anders", attendees: [], sections: [] });

    const envelope = await run(baseParams);

    expect(envelope.result.report_type).toBe(baseParams.policyKey);
    expect(envelope.result.subject).toBe(baseParams.subject);
  });

  // Phase 15 item 1: the date used to be workflow.createdAt (the
  // upload/generation moment, not the conversation date) -- see
  // docs/phase-15/README.md item 1. The model now extracts it from the
  // source text itself.
  it("uses the model's extracted conversation_date when the source text mentions one", async () => {
    mockLlmResponse({ title: "x", attendees: [], sections: [], conversation_date: "12 maart 2026" });

    const envelope = await run(baseParams);

    expect(envelope.result.date).toBe("12 maart 2026");
  });

  it("falls back to a 'not recorded' placeholder when the model finds no date in the source", async () => {
    mockLlmResponse({ title: "x", attendees: [], sections: [], conversation_date: null });

    const envelope = await run(baseParams);

    expect(envelope.result.date).toBe(DATE_NOT_RECORDED);
  });

  it("does not instruct the model with a fixed date up front -- no 'Datum:' fact in the user message", async () => {
    mockLlmResponse({ title: "x", attendees: [], sections: [] });

    await run(baseParams);

    const call = createMock.mock.calls[0][0];
    const userMessage = call.messages[0].content as string;
    expect(userMessage).not.toMatch(/^Datum:/m);
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

  // Phase 14 (docs/phase-14/README.md, "Transcript + notities als context
  // meegeeft"): mergedContent is Merger's already-combined output, so a
  // notes-sourced section (distinct from transcript-only content) reaching
  // the user message confirms both sources flow through, not just the
  // transcript.
  it("includes notes-sourced content, not just transcript content, when the merge combined both", async () => {
    mockLlmResponse({ title: "x", attendees: [], sections: [] });

    const mergedContent = [
      "Transcript: we bespraken de voortgang van het project.",
      "Eigen aantekening: actiepunt toevoegen voor de volgende sprint.",
    ].join("\n");

    await run({ ...baseParams, mergedContent });

    const call = createMock.mock.calls[0][0];
    const userMessage = call.messages[0].content as string;
    expect(userMessage).toContain("Transcript: we bespraken de voortgang van het project.");
    expect(userMessage).toContain("Eigen aantekening: actiepunt toevoegen voor de volgende sprint.");
  });

  // No language-detection library is introduced (out of scope without
  // explicit approval to change the prompt) -- this only confirms the code
  // path is a pure pass-through, i.e. nothing strips or mangles the model's
  // Dutch response, so if the real model does answer in Dutch (as its system
  // prompt instructs), that text survives unmodified into the result.
  it("passes the model's Dutch response through unmodified (no code-side translation/mangling)", async () => {
    const dutchTitle = "Gespreksverslag Werkoverleg Budgetbespreking";
    mockLlmResponse({
      title: dutchTitle,
      attendees: ["Jan Jansen (voorzitter)"],
      sections: [{ heading: "Samenvatting", content: "Wij bespraken het budget en de planning voor volgend kwartaal." }],
    });

    const envelope = await run(baseParams);

    expect(envelope.result.title).toBe(dutchTitle);
    expect(envelope.result.sections[0].content).toBe("Wij bespraken het budget en de planning voor volgend kwartaal.");
  });

  // Phase 14 ("genereert het volledige gespreksverslag" / geen loutere
  // samenvatting): a realistic multi-topic transcript should come back as
  // multiple, substantial sections -- not one short summary paragraph.
  it("parses multiple substantial sections for a multi-topic transcript, not a single short paragraph", async () => {
    mockLlmResponse({
      title: "Gespreksverslag Werkoverleg",
      attendees: ["Jan Jansen (voorzitter)"],
      sections: [
        { heading: "Samenvatting", content: "Korte samenvatting van de kernpunten." },
        {
          heading: "Budget",
          content:
            "Uitgebreide bespreking van het budget voor volgend kwartaal, inclusief de verwachte kosten per afdeling.",
        },
        {
          heading: "Personeelsbezetting",
          content: "Uitgebreide bespreking van de personeelsbezetting en de openstaande vacatures.",
        },
      ],
    });

    const envelope = await run(baseParams);

    const nonSummarySections = envelope.result.sections.filter((section) => section.heading !== "Samenvatting");
    expect(nonSummarySections.length).toBeGreaterThan(1);
    for (const section of nonSummarySections) {
      expect(section.content.length).toBeGreaterThan(40);
    }
  });

  // Phase 15 item 3: a summary written as one "•"-separated string instead
  // of real line breaks used to display/render as a single unreadable line
  // downstream -- normalizeSectionContent() splits it before it's stored.
  it("splits inline bullet-separated content ('• a • b • c') onto separate lines", async () => {
    mockLlmResponse({
      title: "x",
      attendees: [],
      sections: [{ heading: "Samenvatting", content: "• Eerste punt • Tweede punt • Derde punt" }],
    });

    const envelope = await run(baseParams);

    expect(envelope.result.sections[0].content).toBe("• Eerste punt\n• Tweede punt\n• Derde punt");
  });

  it("leaves section content without any '•' marker unchanged", async () => {
    mockLlmResponse({
      title: "x",
      attendees: [],
      sections: [{ heading: "Samenvatting", content: "Gewone lopende tekst zonder bullets." }],
    });

    const envelope = await run(baseParams);

    expect(envelope.result.sections[0].content).toBe("Gewone lopende tekst zonder bullets.");
  });
});
