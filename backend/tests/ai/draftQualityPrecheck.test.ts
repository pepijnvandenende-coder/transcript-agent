import { beforeEach, describe, expect, it, vi } from "vitest";
import { DraftQualityPrecheckEnvelopeSchema } from "../../src/ai/skillEnvelope";
import { DATE_NOT_RECORDED } from "../../src/ai/skills/draftGenerator";
import * as draftQualityPrecheck from "../../src/ai/skills/draftQualityPrecheck";

// Phase 14: replaces the Phase 7 deterministic-stub tests with the real-LLM
// mocking pattern of tests/ai/reportTypeAdvisor.test.ts / draftGenerator.test.ts
// -- prompt construction and response parsing are exercised, not the real
// model. The structural half (title/attendees/date/subject/required
// sections/bodyContentRule) is now computed up front by
// approval/reportStructureValidator.ts and passed in as `structuralItems`,
// so it's supplied directly here rather than recomputed.
//
// Phase 15 item 2: the old freeform two-item checklist (one bundled
// "attendees/date/subject" item, one factual-grounding item) is replaced by
// a fixed five-item Dutch checklist -- Deelnemers/Datum/Onderwerp each get
// their own entry, the remaining structural items roll up into one
// "Structuur voldoet" item, and factual grounding stays its own item. See
// docs/phase-15/README.md item 2.
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

const ALL_CORRECT = { attendees_correct: true, date_correct: true, subject_correct: true, factually_grounded: true, issues: [] };

function mockLlmResponse(output: {
  attendees_correct: boolean;
  date_correct: boolean;
  subject_correct: boolean;
  factually_grounded: boolean;
  issues: string[];
}) {
  createMock.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify(output) }] });
}

describe("ai/skills/draftQualityPrecheck (real LLM, mocked client)", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("skips the LLM call and reports every field as absent/incomplete when there are no sections at all", async () => {
    const envelope = await draftQualityPrecheck.run({ ...BASE_PARAMS, sections: [], structuralItems: PASSING_STRUCTURAL_ITEMS });

    expect(createMock).not.toHaveBeenCalled();
    expect(envelope.result.checklist).toEqual([
      { item: "Deelnemers correct overgenomen", passed: true },
      { item: "Datum correct overgenomen", passed: true },
      { item: "Onderwerp correct overgenomen", passed: true },
      { item: "Structuur voldoet", passed: true },
      { item: "Inhoud bevat niet-onderbouwde informatie", passed: false },
    ]);
    expect(envelope.result.blocking_issues).toContain("Conceptverslag bevat geen inhoud om te beoordelen.");
  });

  it("still runs the LLM call and shows the full checklist when the structural precheck fails on one item", async () => {
    mockLlmResponse(ALL_CORRECT);
    const structuralItems = [...PASSING_STRUCTURAL_ITEMS.slice(0, -1), { item: "Thematische notulen", passed: false }];

    const envelope = await draftQualityPrecheck.run({ ...BASE_PARAMS, structuralItems });

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(envelope.result.checklist).toEqual([
      { item: "Deelnemers correct overgenomen", passed: true },
      { item: "Datum correct overgenomen", passed: true },
      { item: "Onderwerp correct overgenomen", passed: true },
      { item: "Structuur onvolledig", passed: false },
      { item: "Inhoud sluit aan op het transcript", passed: true },
    ]);
    expect(envelope.result.blocking_issues).toEqual(["Structuur van het conceptverslag is onvolledig."]);
  });

  it("calls the LLM and returns a full five-item checklist, all passing, when everything is correct", async () => {
    mockLlmResponse(ALL_CORRECT);

    const envelope = await draftQualityPrecheck.run({ ...BASE_PARAMS, structuralItems: PASSING_STRUCTURAL_ITEMS });

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(envelope.result.checklist).toEqual([
      { item: "Deelnemers correct overgenomen", passed: true },
      { item: "Datum correct overgenomen", passed: true },
      { item: "Onderwerp correct overgenomen", passed: true },
      { item: "Structuur voldoet", passed: true },
      { item: "Inhoud sluit aan op het transcript", passed: true },
    ]);
    expect(envelope.result.overall_score).toBe(1);
    expect(envelope.result.blocking_issues).toEqual([]);
    expect(envelope.result.recommendation).toMatch(/geslaagd/i);
  });

  // The exact bug reported in Phase 15: a bundled item used to fail (and
  // show as "missing") the moment ANY one of attendees/date/subject was
  // doubted, hiding that the other two were genuinely correct.
  it("shows attendees as correct even when date is flagged incorrect -- no longer bundled together", async () => {
    mockLlmResponse({ ...ALL_CORRECT, date_correct: false, issues: ["De genoemde datum komt niet voor in de brontekst."] });

    const envelope = await draftQualityPrecheck.run({ ...BASE_PARAMS, structuralItems: PASSING_STRUCTURAL_ITEMS });

    expect(envelope.result.checklist).toContainEqual({ item: "Deelnemers correct overgenomen", passed: true });
    expect(envelope.result.checklist).toContainEqual({ item: "Onderwerp correct overgenomen", passed: true });
    expect(envelope.result.checklist).toContainEqual({ item: "Datum wijkt af van het transcript", passed: false });
    expect(envelope.result.blocking_issues).toEqual(["De genoemde datum komt niet voor in de brontekst."]);
  });

  it("shows 'Datum ontbreekt' (not a content judgment) when the date is the DraftGenerator 'not recorded' placeholder", async () => {
    mockLlmResponse(ALL_CORRECT);

    const envelope = await draftQualityPrecheck.run({ ...BASE_PARAMS, date: DATE_NOT_RECORDED, structuralItems: PASSING_STRUCTURAL_ITEMS });

    expect(envelope.result.checklist).toContainEqual({ item: "Datum ontbreekt", passed: false });
    expect(envelope.result.blocking_issues).toContain("Datum ontbreekt.");
  });

  it("shows 'Deelnemers ontbreken' when attendees is structurally empty", async () => {
    mockLlmResponse(ALL_CORRECT);
    const structuralItems = [{ item: "Aanwezige deelnemers", passed: false }, ...PASSING_STRUCTURAL_ITEMS.slice(1)];

    const envelope = await draftQualityPrecheck.run({ ...BASE_PARAMS, attendees: [], structuralItems });

    expect(envelope.result.checklist).toContainEqual({ item: "Deelnemers ontbreken", passed: false });
  });

  it("surfaces a signaled factual deviation as a failed 'Inhoud' checklist item", async () => {
    mockLlmResponse({ ...ALL_CORRECT, factually_grounded: false, issues: ["Het verslag noemt een besluit dat niet in de brontekst voorkomt."] });

    const envelope = await draftQualityPrecheck.run({ ...BASE_PARAMS, structuralItems: PASSING_STRUCTURAL_ITEMS });

    expect(envelope.result.checklist).toContainEqual({ item: "Inhoud bevat niet-onderbouwde informatie", passed: false });
    expect(envelope.result.blocking_issues).toEqual(["Het verslag noemt een besluit dat niet in de brontekst voorkomt."]);
  });

  it("includes the draft content and source text in the user message sent to the LLM", async () => {
    mockLlmResponse(ALL_CORRECT);

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
    mockLlmResponse(ALL_CORRECT);

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
    mockLlmResponse(ALL_CORRECT);

    const envelope = await draftQualityPrecheck.run({ ...BASE_PARAMS, structuralItems: PASSING_STRUCTURAL_ITEMS });

    const parsed = DraftQualityPrecheckEnvelopeSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
    expect(envelope.skill).toBe(draftQualityPrecheck.SKILL_NAME);
    expect(envelope.schema_version).toBe(draftQualityPrecheck.SCHEMA_VERSION);
  });
});
