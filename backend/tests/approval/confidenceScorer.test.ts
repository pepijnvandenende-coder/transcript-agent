import { describe, expect, it } from "vitest";
import { computeConfidence } from "../../src/approval/confidenceScorer";

// Pure logic -- no database needed.
describe("confidenceScorer.computeConfidence", () => {
  it("weights llm_self_reported at 0.7 and the (stubbed) structural_score at 0.3", () => {
    const breakdown = computeConfidence(1);
    expect(breakdown.llmSelfReported).toBe(1);
    expect(breakdown.confidence).toBeCloseTo(0.7 * 1 + 0.3 * breakdown.structuralScore, 5);
  });

  it("clamps the result to [0, 1]", () => {
    const low = computeConfidence(0);
    expect(low.confidence).toBeGreaterThanOrEqual(0);
    expect(low.confidence).toBeLessThanOrEqual(1);

    const high = computeConfidence(1);
    expect(high.confidence).toBeGreaterThanOrEqual(0);
    expect(high.confidence).toBeLessThanOrEqual(1);
  });

  it("stores llm_self_reported and structural_score separately, never just the final number", () => {
    const breakdown = computeConfidence(0.6);
    expect(breakdown).toHaveProperty("llmSelfReported");
    expect(breakdown).toHaveProperty("structuralScore");
    expect(breakdown).toHaveProperty("confidence");
  });
});
