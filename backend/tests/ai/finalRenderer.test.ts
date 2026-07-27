import { describe, expect, it } from "vitest";
import * as finalRenderer from "../../src/ai/skills/finalRenderer";

// Pure logic -- no database needed.
describe("ai/skills/finalRenderer", () => {
  describe("renderContent", () => {
    it("includes the header fields", () => {
      const content = finalRenderer.renderContent({
        title: "Gespreksverslag Test",
        attendees: ["Jan (voorzitter)", "Piet (notulist)"],
        date: "2026-01-01",
        subject: "Test",
        sections: [],
      });

      expect(content).toContain("Titel: Gespreksverslag Test");
      expect(content).toContain("Aanwezige deelnemers: Jan (voorzitter), Piet (notulist)");
      expect(content).toContain("Datum: 2026-01-01");
      expect(content).toContain("Onderwerp: Test");
    });

    it("falls back to a placeholder when there are no attendees, rather than fabricating one", () => {
      const content = finalRenderer.renderContent({
        title: "x",
        attendees: [],
        date: "2026-01-01",
        subject: "x",
        sections: [],
      });
      expect(content).toContain("Aanwezige deelnemers: Niet vastgelegd");
    });

    it("includes every section's heading and content verbatim", () => {
      const content = finalRenderer.renderContent({
        title: "x",
        attendees: [],
        date: "2026-01-01",
        subject: "x",
        sections: [
          { heading: "Samenvatting", content: "kernpunt A" },
          { heading: "Notulen", content: "detail B" },
        ],
      });
      expect(content).toContain("## Samenvatting");
      expect(content).toContain("kernpunt A");
      expect(content).toContain("## Notulen");
      expect(content).toContain("detail B");
    });

    it("is deterministic -- identical input produces identical output", () => {
      const input = {
        title: "x",
        attendees: ["a"],
        date: "2026-01-01",
        subject: "x",
        sections: [{ heading: "Samenvatting", content: "y" }],
      };
      expect(finalRenderer.renderContent(input)).toBe(finalRenderer.renderContent(input));
    });
  });

  // Phase 15 item 4: the primary final-report format -- see
  // docs/phase-15/README.md item 4. The `docx` library's own output is
  // third-party, well-tested binary content; these tests cover what this
  // codebase is actually responsible for -- the applicable-section filter
  // and that renderDocx() produces a genuine, non-empty .docx file end to
  // end. Structural content-block parsing (tables/bullets/paragraphs) is
  // covered separately in tests/rendering/parseContentBlocks.test.ts.
  describe("isApplicableSection", () => {
    it("is applicable when content is non-empty prose", () => {
      expect(finalRenderer.isApplicableSection({ heading: "Acties en vervolgstappen", content: "Actie: X" })).toBe(true);
    });

    it("is not applicable when content is empty or whitespace-only", () => {
      expect(finalRenderer.isApplicableSection({ heading: "Bijlagen/verwijzingen", content: "" })).toBe(false);
      expect(finalRenderer.isApplicableSection({ heading: "Bijlagen/verwijzingen", content: "   " })).toBe(false);
    });

    it.each(["n.v.t.", "N.v.t", "nvt", "niet van toepassing", "Geen"])(
      "is not applicable for the placeholder '%s'",
      (placeholder) => {
        expect(finalRenderer.isApplicableSection({ heading: "Openstaande vragen", content: placeholder })).toBe(false);
      },
    );
  });

  describe("renderDocx", () => {
    it("produces a non-empty, genuine .docx (ZIP) file", async () => {
      const buffer = await finalRenderer.renderDocx({
        title: "Gespreksverslag Test",
        attendees: ["Jan (voorzitter)"],
        date: "2026-01-01",
        subject: "Test",
        sections: [
          { heading: "Samenvatting", content: "- Eerste punt\n- Tweede punt" },
          {
            heading: "Acties en vervolgstappen",
            content: "| Actie | Status |\n|-------|--------|\n| Plan opstellen | Open |",
          },
          { heading: "Openstaande vragen / onduidelijkheden", content: "n.v.t." },
        ],
      });

      expect(buffer.length).toBeGreaterThan(0);
      expect(Array.from(buffer.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    });

    it("does not throw for a draft with no sections at all", async () => {
      const buffer = await finalRenderer.renderDocx({
        title: "x",
        attendees: [],
        date: "2026-01-01",
        subject: "x",
        sections: [],
      });
      expect(buffer.length).toBeGreaterThan(0);
    });
  });

  describe("run", () => {
    it("emits the minimal, valid envelope shape", () => {
      const envelope = finalRenderer.run();
      expect(envelope.skill).toBe("FinalRenderer");
      expect(envelope.schema_version).toBe(finalRenderer.SCHEMA_VERSION);
      expect(envelope.result).toEqual({ rendered: true });
      expect(envelope.confidence).toBeGreaterThanOrEqual(0);
      expect(envelope.confidence).toBeLessThanOrEqual(1);
    });
  });
});
