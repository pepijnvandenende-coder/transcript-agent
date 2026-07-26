import { describe, expect, it } from "vitest";
import { DraftGeneratorEnvelopeSchema } from "../../src/ai/skillEnvelope";
import { run, SCHEMA_VERSION, SKILL_NAME } from "../../src/ai/skills/draftGenerator";

// Phase 6 locked decision: this skill is a deterministic stub, not a real
// LLM call. It echoes real source data (merged content excerpt, the
// workflow's own title/date) rather than inventing details, per the "no
// assumptions/new facts" requirement -- these tests confirm shape,
// determinism, and that the required Dutch headings (Samenvatting, Notulen)
// are always present regardless of which report type policy is selected.
describe("draftGenerator (stub)", () => {
  const baseParams = {
    mergedContent: "Dit is de samengevoegde inhoud van het gesprek.",
    policyKey: "thematic",
    subject: "Werkoverleg",
    date: "2026-01-01",
  };

  it("returns an envelope that validates against the shared schema", () => {
    const envelope = run(baseParams);
    const parsed = DraftGeneratorEnvelopeSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
    expect(envelope.skill).toBe(SKILL_NAME);
    expect(envelope.schema_version).toBe(SCHEMA_VERSION);
  });

  it("is deterministic for the same input", () => {
    const a = run(baseParams);
    const b = run(baseParams);
    expect(a).toEqual(b);
  });

  it("always includes the Samenvatting and Notulen headings", () => {
    const envelope = run(baseParams);
    const headings = envelope.result.sections.map((section) => section.heading);
    expect(headings).toContain("Samenvatting");
    expect(headings).toContain("Notulen");
  });

  it("reuses the workflow's own title and date rather than inventing them", () => {
    const envelope = run(baseParams);
    expect(envelope.result.title).toBe(`Gespreksverslag ${baseParams.subject}`);
    expect(envelope.result.subject).toBe(baseParams.subject);
    expect(envelope.result.date).toBe(baseParams.date);
    expect(envelope.result.report_type).toBe(baseParams.policyKey);
  });

  it("leaves attendees empty rather than fabricating a placeholder name", () => {
    const envelope = run(baseParams);
    expect(envelope.result.attendees).toEqual([]);
  });

  it("echoes the merged content excerpt in both Samenvatting and Notulen", () => {
    const envelope = run(baseParams);
    const samenvatting = envelope.result.sections.find((s) => s.heading === "Samenvatting")!;
    const notulen = envelope.result.sections.find((s) => s.heading === "Notulen")!;
    expect(samenvatting.content).toContain("samengevoegde inhoud");
    expect(notulen.content).toContain("samengevoegde inhoud");
  });

  it("labels Notulen differently for the qa policy than for thematic", () => {
    const thematic = run({ ...baseParams, policyKey: "thematic" });
    const qa = run({ ...baseParams, policyKey: "qa" });
    const thematicNotulen = thematic.result.sections.find((s) => s.heading === "Notulen")!.content;
    const qaNotulen = qa.result.sections.find((s) => s.heading === "Notulen")!.content;
    expect(thematicNotulen).not.toBe(qaNotulen);
  });

  it("reports zero coverage when there is no merged content", () => {
    const envelope = run({ ...baseParams, mergedContent: "" });
    expect(envelope.result.coverage).toBe(0);
  });
});
