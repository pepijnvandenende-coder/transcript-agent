import { describe, expect, it } from "vitest";
import { ReportTypeAdvisorEnvelopeSchema } from "../../src/ai/skillEnvelope";
import { run, SCHEMA_VERSION, SKILL_NAME } from "../../src/ai/skills/reportTypeAdvisor";

// Phase 5 locked decision: this skill is a deterministic stub, not a real
// LLM call -- these tests only need to confirm its output shape, determinism,
// and category branching. Confidence is fixed and unused for routing
// (ReportTypeAdvisor's policy is MANDATORY unconditionally).
describe("reportTypeAdvisor (stub)", () => {
  it("returns an envelope that validates against the shared schema", () => {
    const envelope = run("some merged content");
    const parsed = ReportTypeAdvisorEnvelopeSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
    expect(envelope.skill).toBe(SKILL_NAME);
    expect(envelope.schema_version).toBe(SCHEMA_VERSION);
  });

  it("is deterministic for the same input", () => {
    const a = run("the same merged content");
    const b = run("the same merged content");
    expect(a).toEqual(b);
  });

  it("suggests an incident report when the content mentions an incident", () => {
    const envelope = run("There was a serious incident on site yesterday.");
    expect(envelope.result.suggested_type).toBe("Incident Report");
    expect(envelope.result.runner_up).toBe("Standard Audit Summary");
  });

  it("defaults to a standard summary when there is no incident signal", () => {
    const envelope = run("A routine review of the quarterly audit process.");
    expect(envelope.result.suggested_type).toBe("Standard Audit Summary");
    expect(envelope.result.runner_up).toBe("Incident Report");
  });

  it("always includes a non-empty rationale", () => {
    const envelope = run("anything");
    expect(envelope.result.rationale.length).toBeGreaterThan(0);
  });
});
