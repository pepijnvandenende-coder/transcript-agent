import { beforeEach, describe, expect, it, vi } from "vitest";
import { DraftQualityPrecheckEnvelopeSchema } from "../../src/ai/skillEnvelope";
import * as draftQualityPrecheck from "../../src/ai/skills/draftQualityPrecheck";

// Phase 14: replaces the Phase 7 deterministic-stub tests with the real-LLM
// mocking pattern of tests/ai/reportTypeAdvisor.test.ts / draftGenerator.test.ts
// -- prompt construction and response parsing are exercised, not the real
// model. The structural half (title/attendees/date/subject/required
// sections/bodyContentRule) is now computed up front by
// approval/reportStructureValidator.ts and passed in as `structuralItems`,
// so it's supplied directly here rather than recomputed.
const createMock = vi.fn();
vi.mock("../../src/ai/anthropicClient", () => ({
  getAnthropicClient: () => ({ messages: { create: createMock } }),
}));

const PASSING_STRUCTURAL_ITEMS = [
  { item: "Titel", passed: true },
  { item: "Aanwezige deelnemers", passed: true },
  { item: "Datum", passed: true },
  { item: "Onderwerp", passed: true },
  { item: "Samenvatting", passed: true },
  { item: "Thematische notulen", passed: true },
];

const BASE_PARAMS = {
  title: "Gespreksverslag Test",
  attendees: ["Jan Jansen (projectleider)"],
  date: "2026-01-01",
  subject: "Testonderwerp",
  sections: [
    { heading: "Samenvatting", content: "Kernpunten van het gesprek." },
    { heading: "Notulen", content: "Gedetailleerde weergave van het gesprek." },
  ],
  sourceText: "Jan Jansen: We bespraken de kernpunten op 2026-01-01.",
};

function mockLlmResponse(output: { checklist: Array<{ item: string; passed: boolean }>; blocking_issues: string[]; recommendation: string }) {
  createMock.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify(output) }] });
}

describe("ai/skills/draftQualityPrecheck (real LLM, mocked client)", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("skips the LLM call and reports structural failures when the structural precheck fails", async () => {
    const structuralItems = [...PASSING_STRUCTURAL_ITEMS.slice(0, -1), { item: "Thematische notulen", passed: false }];

    const envelope = await draftQualityPrecheck.run({ ...BASE_PARAMS, structuralItems });

    expect(createMock).not.toHaveBeenCalled();
    expect(envelope.result.checklist).toEqual(structuralItems);
    expect(envelope.result.blocking_issues).toEqual(["Ontbrekend of leeg verplicht onderdeel: Thematische notulen"]);
    expect(envelope.result.overall_score).toBeLessThan(1);
  });

  it("calls the LLM and merges structural + content-judged checklist items once structure passes", async () => {
    mockLlmResponse({
      checklist: [
        { item: "Deelnemers/datum/onderwerp correct overgenomen", passed: true },
        { item: "Tekst feitelijk onderbouwd door brontekst", passed: true },
      ],
      blocking_issues: [],
      recommendation: "Ziet er goed uit.",
    });

    const envelope = await draftQualityPrecheck.run({ ...BASE_PARAMS, structuralItems: PASSING_STRUCTURAL_ITEMS });

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(envelope.result.checklist).toEqual([
      ...PASSING_STRUCTURAL_ITEMS,
      { item: "Deelnemers/datum/onderwerp correct overgenomen", passed: true },
      { item: "Tekst feitelijk onderbouwd door brontekst", passed: true },
    ]);
    expect(envelope.result.overall_score).toBe(1);
    expect(envelope.result.blocking_issues).toEqual([]);
    expect(envelope.result.recommendation).toBe("Ziet er goed uit.");
  });

  it("surfaces a signaled deviation -- e.g. attendees not actually in the source text -- as a failed checklist item", async () => {
    mockLlmResponse({
      checklist: [
        { item: "Deelnemers/datum/onderwerp correct overgenomen", passed: false },
        { item: "Tekst feitelijk onderbouwd door brontekst", passed: true },
      ],
      blocking_issues: ["Deelnemer 'Piet Peters' komt niet voor in de brontekst."],
      recommendation: "Controleer de deelnemerslijst.",
    });

    const envelope = await draftQualityPrecheck.run({ ...BASE_PARAMS, structuralItems: PASSING_STRUCTURAL_ITEMS });

    expect(envelope.result.blocking_issues).toEqual(["Deelnemer 'Piet Peters' komt niet voor in de brontekst."]);
    expect(envelope.result.overall_score).toBeLessThan(1);
  });

  it("surfaces a signaled factual deviation -- content not grounded in the source -- as a failed checklist item", async () => {
    mockLlmResponse({
      checklist: [
        { item: "Deelnemers/datum/onderwerp correct overgenomen", passed: true },
        { item: "Tekst feitelijk onderbouwd door brontekst", passed: false },
      ],
      blocking_issues: ["Het verslag noemt een besluit dat niet in de brontekst voorkomt."],
      recommendation: "Controleer de feitelijke onderbouwing.",
    });

    const envelope = await draftQualityPrecheck.run({ ...BASE_PARAMS, structuralItems: PASSING_STRUCTURAL_ITEMS });

    expect(envelope.result.checklist.find((entry) => entry.item === "Tekst feitelijk onderbouwd door brontekst")?.passed).toBe(false);
    expect(envelope.result.blocking_issues).toEqual(["Het verslag noemt een besluit dat niet in de brontekst voorkomt."]);
  });

  it("includes the draft content and source text in the user message sent to the LLM", async () => {
    mockLlmResponse({ checklist: [], blocking_issues: [], recommendation: "x" });

    await draftQualityPrecheck.run({ ...BASE_PARAMS, structuralItems: PASSING_STRUCTURAL_ITEMS });

    const call = createMock.mock.calls[0][0];
    const userMessage = call.messages[0].content as string;
    expect(userMessage).toContain(BASE_PARAMS.title);
    expect(userMessage).toContain(BASE_PARAMS.sourceText);
    expect(userMessage).toContain("Gedetailleerde weergave van het gesprek.");
  });

  // Regression test for the exact false positive found in the last live
  // test (docs/phase-14/README.md, Bevinding 2): a Q&A draft with
  // topic-headed sections (no literal "Notulen" heading) must not produce
  // a "Notulen ontbreekt" (or any structural) blocking issue.
  it("regression: a qa draft with topic-headed Q&A sections produces no blocking issues", async () => {
    mockLlmResponse({
      checklist: [
        { item: "Deelnemers/datum/onderwerp correct overgenomen", passed: true },
        { item: "Tekst feitelijk onderbouwd door brontekst", passed: true },
      ],
      blocking_issues: [],
      recommendation: "Ziet er goed uit.",
    });

    const qaStructuralItems = [
      { item: "Titel", passed: true },
      { item: "Aanwezige deelnemers", passed: true },
      { item: "Datum", passed: true },
      { item: "Onderwerp", passed: true },
      { item: "Samenvatting", passed: true },
      { item: "Vraag/antwoord-secties", passed: true },
    ];

    const envelope = await draftQualityPrecheck.run({
      ...BASE_PARAMS,
      sections: [
        { heading: "Samenvatting", content: "Kernpunten van de vraag-en-antwoordsessie." },
        {
          heading: "Importeren van gegevens",
          content: "Vraag: Hoe importeer ik gegevens?\n\nAntwoord: Via het menu Import.",
        },
      ],
      structuralItems: qaStructuralItems,
    });

    expect(envelope.result.blocking_issues).toEqual([]);
    expect(envelope.result.checklist.find((entry) => entry.item === "Notulen")).toBeUndefined();
  });

  it("returns an envelope that validates against the shared schema", async () => {
    mockLlmResponse({
      checklist: [
        { item: "Deelnemers/datum/onderwerp correct overgenomen", passed: true },
        { item: "Tekst feitelijk onderbouwd door brontekst", passed: true },
      ],
      blocking_issues: [],
      recommendation: "Ziet er goed uit.",
    });

    const envelope = await draftQualityPrecheck.run({ ...BASE_PARAMS, structuralItems: PASSING_STRUCTURAL_ITEMS });

    const parsed = DraftQualityPrecheckEnvelopeSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
    expect(envelope.skill).toBe(draftQualityPrecheck.SKILL_NAME);
    expect(envelope.schema_version).toBe(draftQualityPrecheck.SCHEMA_VERSION);
  });
});
