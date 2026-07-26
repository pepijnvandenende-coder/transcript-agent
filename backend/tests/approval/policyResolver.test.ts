import { PolicyType } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getMaxRetries, resolvePolicy } from "../../src/approval/policyResolver";
import { prisma } from "../../src/persistence/prismaClient";

// Requires a real Postgres database (approval_policies is a shared,
// non-workflow-scoped table) -- see docs/phase-1/README.md for DB setup.
const SKILL_NAME = "TranscriptQualityChecker";
const MERGER_SKILL_NAME = "Merger";
const CONFLICT_DETECTOR_SKILL_NAME = "ConflictDetector";

describe("policyResolver.resolvePolicy", () => {
  beforeAll(async () => {
    await prisma.approvalPolicy.upsert({
      where: { skillName: SKILL_NAME },
      update: { policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.75 },
      create: { skillName: SKILL_NAME, policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.75 },
    });
    await prisma.approvalPolicy.upsert({
      where: { skillName: MERGER_SKILL_NAME },
      update: { policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.8, maxRetries: 5 },
      create: {
        skillName: MERGER_SKILL_NAME,
        policyType: PolicyType.AUTO_IF_ABOVE,
        confidenceThreshold: 0.8,
        maxRetries: 5,
      },
    });
    await prisma.approvalPolicy.upsert({
      where: { skillName: CONFLICT_DETECTOR_SKILL_NAME },
      update: { policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.7, maxRetries: 5 },
      create: {
        skillName: CONFLICT_DETECTOR_SKILL_NAME,
        policyType: PolicyType.AUTO_IF_ABOVE,
        confidenceThreshold: 0.7,
        maxRetries: 5,
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("returns insufficient when the skill's semantic hook fires, regardless of confidence", async () => {
    const resolution = await resolvePolicy({ skillName: SKILL_NAME, result: { sufficient: false }, confidence: 0.99 });
    expect(resolution.outcome).toBe("insufficient");
  });

  it("auto-approves when confidence meets the threshold", async () => {
    const resolution = await resolvePolicy({ skillName: SKILL_NAME, result: { sufficient: true }, confidence: 0.8 });
    expect(resolution.outcome).toBe("auto_approved");
  });

  it("routes to low_confidence when below the threshold", async () => {
    const resolution = await resolvePolicy({ skillName: SKILL_NAME, result: { sufficient: true }, confidence: 0.5 });
    expect(resolution.outcome).toBe("low_confidence");
  });

  it("throws when no approval_policies row exists for the skill", async () => {
    await expect(resolvePolicy({ skillName: "NoSuchSkill", result: {}, confidence: 1 })).rejects.toThrow(
      /No approval_policies row/,
    );
  });

  it("Merger has no semantic hook -- routes purely on confidence vs. its own threshold", async () => {
    const auto = await resolvePolicy({ skillName: MERGER_SKILL_NAME, result: {}, confidence: 0.85 });
    expect(auto.outcome).toBe("auto_approved");

    const low = await resolvePolicy({ skillName: MERGER_SKILL_NAME, result: {}, confidence: 0.5 });
    expect(low.outcome).toBe("low_confidence");
  });

  it("ConflictDetector's semantic hook returns requires_review when conflicts are present, regardless of confidence", async () => {
    const resolution = await resolvePolicy({
      skillName: CONFLICT_DETECTOR_SKILL_NAME,
      result: { conflicts: [{ description: "x" }] },
      confidence: 0.99,
    });
    expect(resolution.outcome).toBe("requires_review");
  });

  it("ConflictDetector falls through to normal confidence scoring when there are no conflicts", async () => {
    const auto = await resolvePolicy({
      skillName: CONFLICT_DETECTOR_SKILL_NAME,
      result: { conflicts: [] },
      confidence: 0.85,
    });
    expect(auto.outcome).toBe("auto_approved");

    const low = await resolvePolicy({
      skillName: CONFLICT_DETECTOR_SKILL_NAME,
      result: { conflicts: [] },
      confidence: 0.5,
    });
    expect(low.outcome).toBe("low_confidence");
  });
});

describe("policyResolver.getMaxRetries", () => {
  it("returns the configured maxRetries for a registered skill", async () => {
    await expect(getMaxRetries(MERGER_SKILL_NAME)).resolves.toBe(5);
  });

  it("falls back to 5 when the skill has no policy row", async () => {
    await expect(getMaxRetries("NoSuchSkill")).resolves.toBe(5);
  });
});
