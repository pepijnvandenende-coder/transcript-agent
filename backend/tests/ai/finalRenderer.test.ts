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
