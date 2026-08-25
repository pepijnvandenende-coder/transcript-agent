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
// Phase 19 item 1: replaces the Phase 15 fixed pass/fail checklist tests --
// every item now carries a PrecheckStatus (ok/info/warning/problem) plus a
// concrete `detail`, and the LLM call returns a `reason` per field instead
// of one freeform `issues` array. See docs for the "Structuur onvolledig"
// UX rework: a reviewer must see WHY a check is a warning, and "the source
// never mentioned this" must never render as a warning.
//
// Actions-consistency fix: this skill no longer asks the LLM whether the
// source contains concrete actions (that used to be a second, independent
// judgment that could disagree with DraftGenerator's own). It now receives
// that answer as `actionsPresentInSource`, the same value DraftGenerator/
// DraftReviser wrote to Draft.actionsPresent -- see draftGenerator.ts's
// ACTIONS_PRESENCE_INSTRUCTIONS and draftQualityPrecheckRunner.ts. The mocked
// LLM response below therefore no longer includes actions_present_in_source
// at all; each test controls the actions outcome via the `actionsPresentInSource`
// param passed straight to run().
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

const ACTIONS_OPTIONAL_SECTIONS = ["Acties en vervolgstappen", "Openstaande vragen / onduidelijkheden", "Bijlagen/verwijzingen"];

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
  optionalSections: ACTIONS_OPTIONAL_SECTIONS,
  actionsPresentInSource: false,
};

const ALL_CORRECT = {
  attendees: { correct: true, reason: "" },
  date: { correct: true, reason: "" },
  subject: { correct: true, reason: "" },
  factually_grounded: { grounded: true, reason: "" },
};

function mockLlmResponse(output: Partial<typeof ALL_CORRECT>) {
  createMock.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify({ ...ALL_CORRECT, ...output }) }] });
}

function itemFor(checklist: Array<{ item: string; status: string; detail: string }>, item: string) {
  return checklist.find((entry) => entry.item === item);
}

describe("ai/skills/draftQualityPrecheck (real LLM, mocked client)", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  // Requirement 10a: everything correct -> every relevant check is "ok".
  it("marks every relevant check ok when everything is correct and no actions were discussed", async () => {
    mockLlmResponse({});

    const envelope = await draftQualityPrecheck.run({ ...BASE_PARAMS, structuralItems: PASSING_STRUCTURAL_ITEMS });

    expect(itemFor(envelope.result.checklist, "Deelnemers")).toEqual({
      item: "Deelnemers",
      status: "ok",
      detail: "Deelnemers correct overgenomen.",
    });
    expect(itemFor(envelope.result.checklist, "Datum")?.status).toBe("ok");
    expect(itemFor(envelope.result.checklist, "Onderwerp")?.status).toBe("ok");
    expect(itemFor(envelope.result.checklist, "Structuur")).toEqual({
      item: "Structuur",
      status: "ok",
      detail: "Structuur voldoet aan het verslagtype.",
    });
    expect(itemFor(envelope.result.checklist, "Inhoud")?.status).toBe("ok");
    expect(envelope.result.overall_score).toBe(1);
  });

  // Requirement 10b / scenario A: no actions in the transcript -> info, never
  // a warning, driven by actionsPresentInSource (the single source of truth),
  // not by anything the LLM says in this call.
  it("shows the actions item as info (not a warning) when actionsPresentInSource is false", async () => {
    mockLlmResponse({});

    const envelope = await draftQualityPrecheck.run({
      ...BASE_PARAMS,
      actionsPresentInSource: false,
      structuralItems: PASSING_STRUCTURAL_ITEMS,
    });

    expect(itemFor(envelope.result.checklist, "Acties en vervolgstappen")).toEqual({
      item: "Acties en vervolgstappen",
      status: "info",
      detail: "Geen concrete acties of vervolgstappen gevonden in het transcript.",
    });
    expect(envelope.result.blocking_issues).not.toContain("Geen concrete acties of vervolgstappen gevonden in het transcript.");
  });

  // Scenario B: actionsPresentInSource true and the draft's own section
  // (which DraftGenerator wrote using the SAME judgment) is present -> ok.
  it("shows the actions item as ok when actionsPresentInSource is true and the draft has the section", async () => {
    mockLlmResponse({});

    const envelope = await draftQualityPrecheck.run({
      ...BASE_PARAMS,
      actionsPresentInSource: true,
      sections: [...BASE_PARAMS.sections, { heading: "Acties en vervolgstappen", content: "Jan stuurt het verslag na." }],
      structuralItems: PASSING_STRUCTURAL_ITEMS,
    });

    expect(itemFor(envelope.result.checklist, "Acties en vervolgstappen")?.status).toBe("ok");
  });

  // Requirement 10c: structure genuinely incomplete -> warning with a
  // concrete detail, never a bare "Structuur onvolledig".
  it("names exactly what's missing when the structural precheck fails on one item", async () => {
    mockLlmResponse({});
    const structuralItems = [...PASSING_STRUCTURAL_ITEMS.slice(0, -1), { item: "Thematische notulen", passed: false }];

    const envelope = await draftQualityPrecheck.run({ ...BASE_PARAMS, structuralItems });

    const structureItem = itemFor(envelope.result.checklist, "Structuur");
    expect(structureItem?.status).toBe("warning");
    expect(structureItem?.detail).toBe(
      "De structuur is onvolledig: er zijn onvoldoende thematische secties gevonden om de indeling compleet te maken.",
    );
    expect(structureItem?.detail).not.toBe("Structuur onvolledig");
    expect(envelope.result.blocking_issues).toEqual([structureItem?.detail]);
  });

  it("lists every missing part when several structural items fail at once", async () => {
    mockLlmResponse({});
    const structuralItems = [
      { item: "Titel", passed: false },
      { item: "Aanwezige deelnemers", passed: true },
      { item: "Datum", passed: true },
      { item: "Onderwerp", passed: true },
      { item: "Samenvatting", passed: false },
      { item: "Thematische notulen", passed: true },
    ];

    const envelope = await draftQualityPrecheck.run({ ...BASE_PARAMS, structuralItems });

    const structureItem = itemFor(envelope.result.checklist, "Structuur");
    expect(structureItem?.detail).toBe(
      "De structuur is onvolledig: de titel ontbreekt; de sectie 'Samenvatting' ontbreekt of is leeg.",
    );
  });

  // A reviewer asking for the "Acties en vervolgstappen" section to be
  // dropped when the transcript does contain actions must still see it
  // flagged -- this is a warning, not something that silently disappears.
  it("flags the actions section as a warning when actionsPresentInSource is true but the section is missing", async () => {
    mockLlmResponse({});

    const envelope = await draftQualityPrecheck.run({
      ...BASE_PARAMS,
      actionsPresentInSource: true,
      structuralItems: PASSING_STRUCTURAL_ITEMS,
    });

    expect(itemFor(envelope.result.checklist, "Acties en vervolgstappen")).toEqual({
      item: "Acties en vervolgstappen",
      status: "warning",
      detail: "De sectie 'Acties en vervolgstappen' ontbreekt, terwijl uit het transcript wel concrete acties naar voren komen.",
    });
  });

  // Requirement 10d: content doubt -> warning with a concrete detail drawn
  // from the LLM's own reason, not a generic sentence.
  it("surfaces a signaled factual deviation as a warning with the LLM's concrete reason", async () => {
    mockLlmResponse({
      factually_grounded: { grounded: false, reason: "Het verslag noemt een besluit dat niet in de brontekst voorkomt." },
    });

    const envelope = await draftQualityPrecheck.run({ ...BASE_PARAMS, structuralItems: PASSING_STRUCTURAL_ITEMS });

    expect(itemFor(envelope.result.checklist, "Inhoud")).toEqual({
      item: "Inhoud",
      status: "warning",
      detail: "Het verslag noemt een besluit dat niet in de brontekst voorkomt.",
    });
    expect(envelope.result.blocking_issues).toContain("Het verslag noemt een besluit dat niet in de brontekst voorkomt.");
  });

  // The exact bug reported in Phase 15: a bundled item used to fail (and
  // show as "missing") the moment ANY one of attendees/date/subject was
  // doubted, hiding that the other two were genuinely correct.
  it("shows attendees as ok even when date is flagged incorrect -- no longer bundled together", async () => {
    mockLlmResponse({ date: { correct: false, reason: "De genoemde datum komt niet voor in de brontekst." } });

    const envelope = await draftQualityPrecheck.run({ ...BASE_PARAMS, structuralItems: PASSING_STRUCTURAL_ITEMS });

    expect(itemFor(envelope.result.checklist, "Deelnemers")?.status).toBe("ok");
    expect(itemFor(envelope.result.checklist, "Onderwerp")?.status).toBe("ok");
    expect(itemFor(envelope.result.checklist, "Datum")).toEqual({
      item: "Datum",
      status: "warning",
      detail: "De genoemde datum komt niet voor in de brontekst.",
    });
  });

  // Requirement 3: information missing from the source is never presented
  // as a defect -- the DraftGenerator "not recorded" placeholder becomes an
  // info item, not a warning.
  it("shows the date as info (not a warning) when it is the DraftGenerator 'not recorded' placeholder", async () => {
    mockLlmResponse({});

    const envelope = await draftQualityPrecheck.run({ ...BASE_PARAMS, date: DATE_NOT_RECORDED, structuralItems: PASSING_STRUCTURAL_ITEMS });

    expect(itemFor(envelope.result.checklist, "Datum")).toEqual({
      item: "Datum",
      status: "info",
      detail: "Datum is niet vastgelegd in het transcript.",
    });
    expect(envelope.result.blocking_issues).toEqual([]);
  });

  it("shows attendees as info (not a warning) when attendees is structurally empty", async () => {
    mockLlmResponse({});
    const structuralItems = [{ item: "Aanwezige deelnemers", passed: false }, ...PASSING_STRUCTURAL_ITEMS.slice(1)];

    const envelope = await draftQualityPrecheck.run({ ...BASE_PARAMS, attendees: [], structuralItems });

    expect(itemFor(envelope.result.checklist, "Deelnemers")).toEqual({
      item: "Deelnemers",
      status: "info",
      detail: "Geen deelnemers gevonden in het transcript.",
    });
  });

  it("includes the draft content and source text in the user message sent to the LLM", async () => {
    mockLlmResponse({});

    await draftQualityPrecheck.run({ ...BASE_PARAMS, structuralItems: PASSING_STRUCTURAL_ITEMS });

    const call = createMock.mock.calls[0][0];
    const userMessage = call.messages[0].content as string;
    expect(userMessage).toContain(BASE_PARAMS.title);
    expect(userMessage).toContain(BASE_PARAMS.sourceText);
    expect(userMessage).toContain("Gedetailleerde weergave van het gesprek.");
  });

  // The LLM is never asked to judge actions presence anymore -- confirms the
  // request the skill actually sends carries no such field/question.
  it("never asks the LLM about actions presence -- the output schema has no actions_present_in_source property", async () => {
    mockLlmResponse({});

    await draftQualityPrecheck.run({ ...BASE_PARAMS, structuralItems: PASSING_STRUCTURAL_ITEMS });

    const call = createMock.mock.calls[0][0];
    const schemaProperties = call.output_config.format.schema.properties;
    expect(schemaProperties).not.toHaveProperty("actions_present_in_source");
  });

  // Regression test for the exact false positive found in the last live
  // test (docs/phase-14/README.md, Bevinding 2): a Q&A draft with
  // topic-headed sections (no literal "Notulen" heading) must not produce
  // a "Notulen ontbreekt" (or any structural) warning.
  it("regression: a qa draft with topic-headed Q&A sections produces no structural warning", async () => {
    mockLlmResponse({});

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

    expect(itemFor(envelope.result.checklist, "Structuur")?.status).toBe("ok");
    expect(envelope.result.blocking_issues.some((issue) => issue.includes("Notulen"))).toBe(false);
  });

  // Requirement 9: never add a check the catalog data doesn't support.
  it("omits the actions item entirely when the report type's policy has no such optional section", async () => {
    mockLlmResponse({});

    const envelope = await draftQualityPrecheck.run({
      ...BASE_PARAMS,
      actionsPresentInSource: true,
      structuralItems: PASSING_STRUCTURAL_ITEMS,
      optionalSections: [],
    });

    expect(itemFor(envelope.result.checklist, "Acties en vervolgstappen")).toBeUndefined();
  });

  // Requirement 10e: everything passes -> a clear, unambiguous final
  // assessment that the draft is ready for human review.
  it("gives a clear final assessment when every check passes", async () => {
    mockLlmResponse({});

    const envelope = await draftQualityPrecheck.run({ ...BASE_PARAMS, structuralItems: PASSING_STRUCTURAL_ITEMS });

    expect(envelope.result.recommendation).toBe(
      "Beoordeling: Het conceptverslag kan worden beoordeeld. Er zijn geen kritieke problemen gevonden.",
    );
  });

  it("tells the reviewer to check the flagged points when a warning is present", async () => {
    mockLlmResponse({ subject: { correct: false, reason: "Het onderwerp wijkt af van wat in de brontekst wordt besproken." } });

    const envelope = await draftQualityPrecheck.run({ ...BASE_PARAMS, structuralItems: PASSING_STRUCTURAL_ITEMS });

    expect(envelope.result.recommendation).toBe("Beoordeling: Controleer de gemarkeerde punten voordat je het verslag goedkeurt.");
  });

  it("skips the LLM call and reports a problem when there are no sections at all", async () => {
    const envelope = await draftQualityPrecheck.run({ ...BASE_PARAMS, sections: [], structuralItems: PASSING_STRUCTURAL_ITEMS });

    expect(createMock).not.toHaveBeenCalled();
    expect(itemFor(envelope.result.checklist, "Inhoud")).toEqual({
      item: "Inhoud",
      status: "problem",
      detail: "Conceptverslag bevat geen inhoud om te beoordelen.",
    });
    expect(envelope.result.recommendation).toBe(
      "Beoordeling: Het conceptverslag bevat een probleem en is nog niet klaar voor beoordeling.",
    );
  });

  // Even with no sections (and thus no LLM call at all), the actions item
  // still reflects actionsPresentInSource -- this doesn't depend on the LLM.
  it("still reports the actions item from actionsPresentInSource when there are no sections at all", async () => {
    const envelope = await draftQualityPrecheck.run({
      ...BASE_PARAMS,
      sections: [],
      actionsPresentInSource: true,
      structuralItems: PASSING_STRUCTURAL_ITEMS,
    });

    expect(itemFor(envelope.result.checklist, "Acties en vervolgstappen")?.status).toBe("warning");
  });

  it("returns an envelope that validates against the shared schema", async () => {
    mockLlmResponse({});

    const envelope = await draftQualityPrecheck.run({ ...BASE_PARAMS, structuralItems: PASSING_STRUCTURAL_ITEMS });

    const parsed = DraftQualityPrecheckEnvelopeSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
    expect(envelope.skill).toBe(draftQualityPrecheck.SKILL_NAME);
    expect(envelope.schema_version).toBe(draftQualityPrecheck.SCHEMA_VERSION);
  });
});
