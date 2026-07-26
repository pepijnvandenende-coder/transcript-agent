import { describe, expect, it } from "vitest";
import { ReportTypeAdvisorEnvelopeSchema } from "../../src/ai/skillEnvelope";
import { run, SCHEMA_VERSION, SKILL_NAME } from "../../src/ai/skills/reportTypeAdvisor";

// Phase 6 locked decision: this skill is a deterministic stub, not a real
// LLM call -- these tests only need to confirm its output shape, determinism,
// and category branching. Confidence is fixed and unused for routing
// (ReportTypeAdvisor's policy is MANDATORY unconditionally). The skill stays
// a pure function (no DB access) -- the catalog's Dutch display names are
// passed in by the caller (jobs/runners/suggestReportTypeRunner.ts), so
// tests supply them directly too.
const LABELS = { thematicLabel: "Thematisch gespreksverslag", qaLabel: "Vraag & antwoord gespreksverslag" };

describe("reportTypeAdvisor (stub)", () => {
  it("returns an envelope that validates against the shared schema", () => {
    const envelope = run("some merged content", LABELS);
    const parsed = ReportTypeAdvisorEnvelopeSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
    expect(envelope.skill).toBe(SKILL_NAME);
    expect(envelope.schema_version).toBe(SCHEMA_VERSION);
  });

  it("is deterministic for the same input", () => {
    const a = run("the same merged content", LABELS);
    const b = run("the same merged content", LABELS);
    expect(a).toEqual(b);
  });

  it("suggests the Q&A policy when the content contains explicit questions", () => {
    const envelope = run("Wat is de status van dit project? En wie is verantwoordelijk?", LABELS);
    expect(envelope.result.suggested_type).toBe(LABELS.qaLabel);
    expect(envelope.result.runner_up).toBe(LABELS.thematicLabel);
  });

  it("defaults to the thematic policy when there are no explicit questions", () => {
    const envelope = run("Een overzicht van de besproken onderwerpen tijdens het overleg.", LABELS);
    expect(envelope.result.suggested_type).toBe(LABELS.thematicLabel);
    expect(envelope.result.runner_up).toBe(LABELS.qaLabel);
  });

  it("always includes a non-empty rationale", () => {
    const envelope = run("anything", LABELS);
    expect(envelope.result.rationale.length).toBeGreaterThan(0);
  });
});
