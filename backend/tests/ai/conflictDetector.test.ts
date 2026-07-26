import { describe, expect, it } from "vitest";
import { ConflictDetectorEnvelopeSchema } from "../../src/ai/skillEnvelope";
import { run, SCHEMA_VERSION, SKILL_NAME } from "../../src/ai/skills/conflictDetector";

// Phase 4 locked decision: this skill is a deterministic stub, not a real
// LLM call -- these tests only need to confirm its output shape, determinism,
// and conflicts-vs-no-conflicts branching driven by unmatched notes.
describe("conflictDetector (stub)", () => {
  it("returns an envelope that validates against the shared schema", () => {
    const envelope = run([]);
    const parsed = ConflictDetectorEnvelopeSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
    expect(envelope.skill).toBe(SKILL_NAME);
    expect(envelope.schema_version).toBe(SCHEMA_VERSION);
  });

  it("is deterministic for the same input", () => {
    const a = run(["a note that didn't merge"]);
    const b = run(["a note that didn't merge"]);
    expect(a).toEqual(b);
  });

  it("reports no conflicts when there are no unmatched notes", () => {
    const envelope = run([]);
    expect(envelope.result.conflicts).toHaveLength(0);
  });

  it("reports one conflict per unmatched note", () => {
    const envelope = run(["first stray note", "second stray note"]);
    expect(envelope.result.conflicts).toHaveLength(2);
    expect(envelope.result.conflicts[0].source_b).toBe("first stray note");
    expect(envelope.result.conflicts[1].source_b).toBe("second stray note");
    for (const conflict of envelope.result.conflicts) {
      expect(conflict.description.length).toBeGreaterThan(0);
    }
  });
});
