import { describe, expect, it } from "vitest";
import * as draftQualityPrecheck from "../../src/ai/skills/draftQualityPrecheck";

// Pure logic -- no database needed.
describe("ai/skills/draftQualityPrecheck", () => {
  const requiredSections = ["Samenvatting", "Notulen"];

  it("passes every required section that has non-empty content", () => {
    const envelope = draftQualityPrecheck.run({
      sections: [
        { heading: "Samenvatting", content: "x" },
        { heading: "Notulen", content: "y" },
      ],
      requiredSections,
    });

    expect(envelope.result.checklist).toEqual([
      { item: "Samenvatting", passed: true },
      { item: "Notulen", passed: true },
    ]);
    expect(envelope.result.blocking_issues).toEqual([]);
    expect(envelope.result.overall_score).toBe(1);
  });

  it("fails a required section that's missing entirely", () => {
    const envelope = draftQualityPrecheck.run({
      sections: [{ heading: "Samenvatting", content: "x" }],
      requiredSections,
    });

    expect(envelope.result.checklist).toEqual([
      { item: "Samenvatting", passed: true },
      { item: "Notulen", passed: false },
    ]);
    expect(envelope.result.blocking_issues).toEqual(["Missing or empty required section: Notulen"]);
    expect(envelope.result.overall_score).toBe(0.5);
  });

  it("fails a required section that's present but has only whitespace content", () => {
    const envelope = draftQualityPrecheck.run({
      sections: [
        { heading: "Samenvatting", content: "x" },
        { heading: "Notulen", content: "   " },
      ],
      requiredSections,
    });

    expect(envelope.result.checklist.find((entry) => entry.item === "Notulen")?.passed).toBe(false);
    expect(envelope.result.blocking_issues).toContain("Missing or empty required section: Notulen");
  });

  it("scores 0 when every required section is missing", () => {
    const envelope = draftQualityPrecheck.run({ sections: [], requiredSections });
    expect(envelope.result.overall_score).toBe(0);
    expect(envelope.result.blocking_issues).toHaveLength(2);
    expect(envelope.result.recommendation).toMatch(/missing/i);
  });

  it("recommendation reflects structural completeness when there are no blocking issues", () => {
    const envelope = draftQualityPrecheck.run({
      sections: [
        { heading: "Samenvatting", content: "x" },
        { heading: "Notulen", content: "y" },
      ],
      requiredSections,
    });
    expect(envelope.result.recommendation).toMatch(/structurally complete/i);
  });

  it("is deterministic -- identical input produces identical output", () => {
    const input = {
      sections: [
        { heading: "Samenvatting", content: "x" },
        { heading: "Notulen", content: "y" },
      ],
      requiredSections,
    };
    expect(draftQualityPrecheck.run(input).result).toEqual(draftQualityPrecheck.run(input).result);
  });

  it("emits a valid envelope shape", () => {
    const envelope = draftQualityPrecheck.run({
      sections: [{ heading: "Samenvatting", content: "x" }],
      requiredSections: ["Samenvatting"],
    });
    expect(envelope.skill).toBe("DraftQualityPrecheck");
    expect(envelope.schema_version).toBe(draftQualityPrecheck.SCHEMA_VERSION);
    expect(envelope.confidence).toBeGreaterThanOrEqual(0);
    expect(envelope.confidence).toBeLessThanOrEqual(1);
  });
});
