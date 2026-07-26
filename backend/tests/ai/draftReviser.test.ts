import { describe, expect, it } from "vitest";
import * as draftReviser from "../../src/ai/skills/draftReviser";

// Pure logic -- no database needed.
describe("ai/skills/draftReviser", () => {
  const previousSections = [
    { heading: "Samenvatting", content: "x" },
    { heading: "Notulen", content: "y" },
  ];

  it("appends each feedback item verbatim into the Notulen section's content", () => {
    const envelope = draftReviser.run({
      previousSections,
      feedbackItems: ["Voeg meer detail toe over besluit A."],
    });

    const notulen = envelope.result.sections.find((s) => s.heading === "Notulen");
    expect(notulen?.content).toContain("y");
    expect(notulen?.content).toContain("Voeg meer detail toe over besluit A.");
  });

  it("leaves other sections unchanged", () => {
    const envelope = draftReviser.run({
      previousSections,
      feedbackItems: ["Some feedback"],
    });

    const samenvatting = envelope.result.sections.find((s) => s.heading === "Samenvatting");
    expect(samenvatting?.content).toBe("x");
  });

  it("produces one changes_applied entry per feedback item processed", () => {
    const envelope = draftReviser.run({
      previousSections,
      feedbackItems: ["Feedback een", "Feedback twee"],
    });

    expect(envelope.result.changes_applied).toHaveLength(2);
    expect(envelope.result.changes_applied[0]).toContain("Feedback een");
    expect(envelope.result.changes_applied[1]).toContain("Feedback twee");
  });

  it("unresolved_feedback is always empty", () => {
    const envelope = draftReviser.run({ previousSections, feedbackItems: ["x", "y", "z"] });
    expect(envelope.result.unresolved_feedback).toEqual([]);
  });

  it("with no feedback items, sections pass through unchanged and nothing is applied", () => {
    const envelope = draftReviser.run({ previousSections, feedbackItems: [] });
    expect(envelope.result.sections).toEqual(previousSections);
    expect(envelope.result.changes_applied).toEqual([]);
  });

  it("does not invent a Notulen section if one isn't present", () => {
    const envelope = draftReviser.run({
      previousSections: [{ heading: "Samenvatting", content: "x" }],
      feedbackItems: ["Feedback with nowhere to go"],
    });
    expect(envelope.result.sections).toEqual([{ heading: "Samenvatting", content: "x" }]);
    expect(envelope.result.changes_applied).toEqual([]);
  });

  it("is deterministic -- identical input produces identical output", () => {
    const input = { previousSections, feedbackItems: ["Feedback"] };
    expect(draftReviser.run(input).result).toEqual(draftReviser.run(input).result);
  });

  it("emits a valid envelope shape", () => {
    const envelope = draftReviser.run({ previousSections, feedbackItems: ["Feedback"] });
    expect(envelope.skill).toBe("DraftReviser");
    expect(envelope.schema_version).toBe(draftReviser.SCHEMA_VERSION);
    expect(envelope.confidence).toBeGreaterThanOrEqual(0);
    expect(envelope.confidence).toBeLessThanOrEqual(1);
  });
});
