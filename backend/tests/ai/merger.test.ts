import { describe, expect, it } from "vitest";
import { MergerEnvelopeSchema } from "../../src/ai/skillEnvelope";
import { run, SCHEMA_VERSION, SKILL_NAME } from "../../src/ai/skills/merger";

// Phase 3 locked decision: this skill is a deterministic stub, not a real
// LLM call -- these tests only need to confirm its output shape, determinism,
// and that confidence varies with notes-presence (unlike Phase 2's
// fixed-confidence stub).
describe("merger (stub)", () => {
  it("returns an envelope that validates against the shared schema", () => {
    const envelope = run("a transcript with real content", "some notes");
    const parsed = MergerEnvelopeSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
    expect(envelope.skill).toBe(SKILL_NAME);
    expect(envelope.schema_version).toBe(SCHEMA_VERSION);
  });

  it("is deterministic for the same input", () => {
    const a = run("same transcript", "same notes");
    const b = run("same transcript", "same notes");
    expect(a).toEqual(b);
  });

  it("produces higher confidence when notes are present", () => {
    const withNotes = run("a transcript", "some notes");
    const withoutNotes = run("a transcript");
    expect(withNotes.confidence).toBeGreaterThan(withoutNotes.confidence);
  });

  it("merges only the transcript section when notes are absent", () => {
    const envelope = run("a transcript");
    expect(envelope.result.merged_sections).toHaveLength(1);
    expect(envelope.result.merged_sections[0].source).toBe("transcript");
    expect(envelope.flags).toContain("no_notes_provided");
  });

  it("merges both transcript and notes sections when notes are present", () => {
    const envelope = run("a transcript", "some notes");
    expect(envelope.result.merged_sections).toHaveLength(2);
    expect(envelope.result.merged_sections.map((s) => s.source)).toEqual(["transcript", "notes"]);
    expect(envelope.flags).not.toContain("no_notes_provided");
  });

  it("treats whitespace-only notes the same as absent notes", () => {
    const envelope = run("a transcript", "   ");
    expect(envelope.result.merged_sections).toHaveLength(1);
  });

  // Phase 13: approval/policyResolver.ts's Merger semantic hook reads this
  // field to auto-approve a notes-absent run unconditionally -- see
  // tests/approval/policyResolver.test.ts.
  it("reports notes_provided in the result, matching notes-presence", () => {
    expect(run("a transcript").result.notes_provided).toBe(false);
    expect(run("a transcript", "   ").result.notes_provided).toBe(false);
    expect(run("a transcript", "some notes").result.notes_provided).toBe(true);
  });
});
