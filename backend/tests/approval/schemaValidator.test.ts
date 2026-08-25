import { describe, expect, it } from "vitest";
import * as conflictDetector from "../../src/ai/skills/conflictDetector";
import * as merger from "../../src/ai/skills/merger";
import { run } from "../../src/ai/skills/transcriptQualityChecker";
import type { DraftGeneratorEnvelope, ReportTypeAdvisorEnvelope } from "../../src/ai/skillEnvelope";
import { checkSchema } from "../../src/approval/schemaValidator";

// DraftGenerator itself now calls the real Anthropic API (Phase 11) -- this
// file tests pure schema-validation logic ("Pure logic -- no database
// needed", see below), so it builds a DraftGenerator-shaped envelope by hand
// rather than depending on the (now async, LLM-backed) draftGenerator.run().
function draftGeneratorEnvelope(): DraftGeneratorEnvelope {
  return {
    skill: "DraftGenerator",
    schema_version: "1.0.0",
    confidence: 1,
    rationale: "test fixture",
    flags: [],
    result: {
      report_type: "thematic",
      title: "Gespreksverslag Test Workflow",
      attendees: [],
      date: "2026-01-01",
      subject: "Test Workflow",
      sections: [
        { heading: "Samenvatting", content: "x" },
        { heading: "Notulen", content: "y" },
      ],
      coverage: 1,
      actions_present: false,
    },
  };
}

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

  // ReportTypeAdvisor itself now calls the real Anthropic API (Phase 13) --
  // this file tests pure schema-validation logic, so it builds a
  // ReportTypeAdvisor-shaped envelope by hand rather than depending on the
  // (now async, LLM-backed) reportTypeAdvisor.run(), same pattern as
  // draftGeneratorEnvelope() above.
  function reportTypeAdvisorEnvelope(): ReportTypeAdvisorEnvelope {
    return {
      skill: "ReportTypeAdvisor",
      schema_version: "1.0.0",
      confidence: 1,
      rationale: "test fixture",
      flags: [],
      result: {
        suggested_type: "thematic",
        rationale: "Het gesprek is opgebouwd rond duidelijke thema's.",
        runner_up: "qa",
      },
    };
  }

  it("accepts a well-formed ReportTypeAdvisor envelope", () => {
    const envelope = reportTypeAdvisorEnvelope();
    const result = checkSchema("ReportTypeAdvisor", envelope);
    expect(result.valid).toBe(true);
  });

  it("rejects a ReportTypeAdvisor envelope missing suggested_type", () => {
    const envelope = reportTypeAdvisorEnvelope();
    const malformed = { ...envelope, result: { rationale: envelope.result.rationale } };
    const result = checkSchema("ReportTypeAdvisor", malformed);
    expect(result.valid).toBe(false);
  });

  it("accepts a well-formed DraftGenerator envelope", () => {
    const envelope = draftGeneratorEnvelope();
    const result = checkSchema("DraftGenerator", envelope);
    expect(result.valid).toBe(true);
  });

  it("rejects a DraftGenerator envelope missing sections", () => {
    const envelope = draftGeneratorEnvelope();
    const malformed = { ...envelope, result: { ...envelope.result, sections: "not an array" } };
    const result = checkSchema("DraftGenerator", malformed);
    expect(result.valid).toBe(false);
  });
});
