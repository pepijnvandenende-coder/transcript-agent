import { describe, expect, it } from "vitest";
import { checkDraftStructure, validateDraftStructure } from "../../src/approval/reportStructureValidator";

// Pure logic -- no database needed. Phase 14: body content ("Notulen" in the
// prompts, but never checked by that literal name here -- see
// docs/phase-14/README.md's Bevinding 2) is validated per report type via
// bodyContentRule, not a fixed requiredSections heading.
describe("reportStructureValidator", () => {
  const baseDraft = {
    title: "Gespreksverslag Test",
    attendees: ["Jan Jansen (projectleider)"],
    date: "2026-01-01",
    subject: "Test onderwerp",
  };

  const thematicPolicy = {
    requiredSections: ["Samenvatting"],
    optionalSections: ["Acties en vervolgstappen", "Openstaande vragen / onduidelijkheden", "Bijlagen/verwijzingen"],
    bodyContentRule: { type: "topic_sections", minCount: 1 },
  };

  const qaPolicy = {
    requiredSections: ["Samenvatting"],
    optionalSections: ["Acties en vervolgstappen", "Openstaande vragen / onduidelijkheden", "Bijlagen/verwijzingen"],
    bodyContentRule: { type: "qa_pairs", minCount: 1 },
  };

  describe("topic_sections (thematic)", () => {
    it("passes with multiple topic sections under arbitrary, different heading names", () => {
      const draft = {
        ...baseDraft,
        sections: [
          { heading: "Samenvatting", content: "Kernpunten." },
          { heading: "Budget 2026", content: "Gesproken over het budget." },
          { heading: "Personeelsbezetting", content: "Gesproken over de bezetting." },
        ],
      };
      expect(validateDraftStructure(draft, thematicPolicy).valid).toBe(true);
    });

    it("passes when the body section happens to be literally called Notulen", () => {
      const draft = {
        ...baseDraft,
        sections: [
          { heading: "Samenvatting", content: "Kernpunten." },
          { heading: "Notulen", content: "Gedetailleerde weergave." },
        ],
      };
      expect(validateDraftStructure(draft, thematicPolicy).valid).toBe(true);
    });

    it("fails when zero topic sections remain beyond Samenvatting", () => {
      const draft = {
        ...baseDraft,
        sections: [{ heading: "Samenvatting", content: "Kernpunten." }],
      };
      const result = validateDraftStructure(draft, thematicPolicy);
      expect(result.valid).toBe(false);
      const items = checkDraftStructure(draft, thematicPolicy);
      expect(items.find((item) => item.item === "Thematische notulen")?.passed).toBe(false);
    });
  });

  describe("qa_pairs (qa)", () => {
    it("passes with multiple Q&A sections, regardless of heading name", () => {
      const draft = {
        ...baseDraft,
        sections: [
          { heading: "Samenvatting", content: "Kernpunten." },
          { heading: "Importeren van gegevens", content: "Vraag: Hoe importeer ik gegevens?\n\nAntwoord: Via het menu Import." },
        ],
      };
      const result = validateDraftStructure(draft, qaPolicy);
      expect(result.valid).toBe(true);
      const items = checkDraftStructure(draft, qaPolicy);
      expect(items.find((item) => item.item === "Vraag/antwoord-secties")?.passed).toBe(true);
    });

    it("a section literally called Notulen without a question/answer marker fails on content, never on the name", () => {
      const draft = {
        ...baseDraft,
        sections: [
          { heading: "Samenvatting", content: "Kernpunten." },
          { heading: "Notulen", content: "Gewoon een lopende tekst zonder duidelijke structuur." },
        ],
      };
      const result = validateDraftStructure(draft, qaPolicy);
      expect(result.valid).toBe(false);
      const items = checkDraftStructure(draft, qaPolicy);
      expect(items.find((item) => item.item === "Notulen")).toBeUndefined();
      expect(items.find((item) => item.item === "Vraag/antwoord-secties")?.passed).toBe(false);
    });

    it("a section literally called Notulen that does contain a question/answer pair passes", () => {
      const draft = {
        ...baseDraft,
        sections: [
          { heading: "Samenvatting", content: "Kernpunten." },
          { heading: "Notulen", content: "Vraag: Wat is de planning?\n\nAntwoord: Q3 2026." },
        ],
      };
      expect(validateDraftStructure(draft, qaPolicy).valid).toBe(true);
    });
  });

  describe("Titel / Aanwezige deelnemers / Datum / Onderwerp", () => {
    const sections = [
      { heading: "Samenvatting", content: "x" },
      { heading: "Onderwerp A", content: "y" },
    ];

    it("fails on an empty title", () => {
      const draft = { ...baseDraft, title: "", sections };
      expect(validateDraftStructure(draft, thematicPolicy).valid).toBe(false);
    });

    it("fails on an empty attendees array", () => {
      const draft = { ...baseDraft, attendees: [], sections };
      expect(validateDraftStructure(draft, thematicPolicy).valid).toBe(false);
    });

    it("fails on an empty date", () => {
      const draft = { ...baseDraft, date: "", sections };
      expect(validateDraftStructure(draft, thematicPolicy).valid).toBe(false);
    });

    it("fails on an empty subject", () => {
      const draft = { ...baseDraft, subject: "", sections };
      expect(validateDraftStructure(draft, thematicPolicy).valid).toBe(false);
    });

    it("passes when all four are present", () => {
      const draft = { ...baseDraft, sections };
      expect(validateDraftStructure(draft, thematicPolicy).valid).toBe(true);
    });
  });

  // Regression test for the exact false positive found in the last live
  // test (docs/phase-14/README.md, Bevinding 2): a Q&A draft whose sections
  // are headed per topic/question ("Het besproken onderwerp/thema als
  // kopje", per qa.md) rather than literally "Notulen" must not be flagged
  // as missing required content.
  it("regression: a qa draft with topic-headed Q&A sections (no literal Notulen heading) is not flagged as incomplete", () => {
    const draft = {
      ...baseDraft,
      sections: [
        { heading: "Samenvatting", content: "Kernpunten van de vraag-en-antwoordsessie." },
        {
          heading: "Importeren van gegevens",
          content: "Vraag: Hoe importeer ik gegevens?\n\nAntwoord: Via het menu Import, kies het CSV-bestand.",
        },
        {
          heading: "Exporteren van rapportages",
          content: "Vraag: Kan ik rapportages exporteren?\n\nAntwoord: Ja, via de knop Exporteren rechtsboven.",
        },
      ],
    };

    const result = validateDraftStructure(draft, qaPolicy);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  // Phase 16 item 5: a revision may deliberately drop or restructure a
  // standard section (e.g. "verwijder acties en vervolgstappen") -- the
  // relaxed { skipContentSections: true } mode used for DraftReviser must
  // accept that instead of treating it as a schema failure.
  describe("skipContentSections (revision)", () => {
    it("passes even when a required content section (Samenvatting) is missing entirely", () => {
      const draft = {
        ...baseDraft,
        sections: [{ heading: "Notulen", content: "Alleen een informatief gesprek, geen vervolgacties." }],
      };
      expect(validateDraftStructure(draft, thematicPolicy).valid).toBe(false);
      expect(validateDraftStructure(draft, thematicPolicy, { skipContentSections: true }).valid).toBe(true);
    });

    it("passes even when zero topic/body sections remain", () => {
      const draft = { ...baseDraft, sections: [] };
      expect(validateDraftStructure(draft, thematicPolicy, { skipContentSections: true }).valid).toBe(true);
    });

    it("still fails when a basic header fact (title/attendees/date/subject) is missing", () => {
      const draft = { ...baseDraft, title: "", sections: [] };
      expect(validateDraftStructure(draft, thematicPolicy, { skipContentSections: true }).valid).toBe(false);
    });
  });
});
