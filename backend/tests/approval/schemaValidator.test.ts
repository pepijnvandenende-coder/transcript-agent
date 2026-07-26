import { describe, expect, it } from "vitest";
import * as conflictDetector from "../../src/ai/skills/conflictDetector";
import * as merger from "../../src/ai/skills/merger";
import { run } from "../../src/ai/skills/transcriptQualityChecker";
import { checkSchema } from "../../src/approval/schemaValidator";

// Pure logic -- no database needed.
describe("schemaValidator.checkSchema", () => {
  it("accepts a well-formed TranscriptQualityChecker envelope", () => {
    const envelope = run("some transcript content");
    const result = checkSchema("TranscriptQualityChecker", envelope);
    expect(result.valid).toBe(true);
  });

  it("rejects an envelope with an out-of-range confidence", () => {
    const envelope = { ...run("some content"), confidence: 2 };
    const result = checkSchema("TranscriptQualityChecker", envelope);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
  });

  it("rejects a raw_output missing the result field entirely", () => {
    const result = checkSchema("TranscriptQualityChecker", { skill: "TranscriptQualityChecker" });
    expect(result.valid).toBe(false);
  });

  it("rejects an unknown skill name", () => {
    const result = checkSchema("SomeUnregisteredSkill", { skill: "SomeUnregisteredSkill" });
    expect(result.valid).toBe(false);
  });

  it("accepts a well-formed Merger envelope", () => {
    const envelope = merger.run("some transcript content", "some notes");
    const result = checkSchema("Merger", envelope);
    expect(result.valid).toBe(true);
  });

  it("rejects a Merger envelope with a malformed merged_sections entry", () => {
    const envelope = merger.run("some transcript content", "some notes");
    const malformed = { ...envelope, result: { ...envelope.result, merged_sections: [{ heading: "x" }] } };
    const result = checkSchema("Merger", malformed);
    expect(result.valid).toBe(false);
  });

  it("accepts a well-formed ConflictDetector envelope", () => {
    const envelope = conflictDetector.run(["a stray note"]);
    const result = checkSchema("ConflictDetector", envelope);
    expect(result.valid).toBe(true);
  });

  it("rejects a ConflictDetector envelope with a non-array conflicts field", () => {
    const envelope = conflictDetector.run(["a stray note"]);
    const malformed = { ...envelope, result: { conflicts: "not an array" } };
    const result = checkSchema("ConflictDetector", malformed);
    expect(result.valid).toBe(false);
  });
});
