import { describe, expect, it } from "vitest";
import { TranscriptQualityEnvelopeSchema } from "../../src/ai/skillEnvelope";
import { run, SCHEMA_VERSION, SKILL_NAME } from "../../src/ai/skills/transcriptQualityChecker";

// Phase 2 locked decision: this skill is a deterministic stub, not a real
// LLM call -- these tests only need to confirm its output shape and
// determinism, not any actual language understanding.
describe("transcriptQualityChecker (stub)", () => {
  it("returns an envelope that validates against the shared schema", () => {
    const envelope = run("This is a perfectly normal transcript with several words in it.");
    const parsed = TranscriptQualityEnvelopeSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
    expect(envelope.skill).toBe(SKILL_NAME);
    expect(envelope.schema_version).toBe(SCHEMA_VERSION);
  });

  it("is deterministic for the same input", () => {
    const a = run("same content");
    const b = run("same content");
    expect(a).toEqual(b);
  });

  it("flags an empty/whitespace-only transcript as insufficient", () => {
    const envelope = run("   ");
    expect(envelope.result.sufficient).toBe(false);
    expect(envelope.result.issues).toContain("transcript_empty");
  });

  it("reports sufficient=true and a word_count metric for non-empty content", () => {
    const envelope = run("one two three");
    expect(envelope.result.sufficient).toBe(true);
    expect(envelope.result.metrics.word_count).toBe(3);
  });
});
