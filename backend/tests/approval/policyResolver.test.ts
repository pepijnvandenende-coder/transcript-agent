import { PolicyType } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getMaxRetries, resolvePolicy } from "../../src/approval/policyResolver";
import { prisma } from "../../src/persistence/prismaClient";

// Requires a real Postgres database (approval_policies is a shared,
// non-workflow-scoped table) -- see docs/phase-1/README.md for DB setup.
const SKILL_NAME = "TranscriptQualityChecker";
const MERGER_SKILL_NAME = "Merger";
const CONFLICT_DETECTOR_SKILL_NAME = "ConflictDetector";
const REPORT_TYPE_ADVISOR_SKILL_NAME = "ReportTypeAdvisor";
const DRAFT_GENERATOR_SKILL_NAME = "DraftGenerator";
const DRAFT_QUALITY_PRECHECK_SKILL_NAME = "DraftQualityPrecheck";
const DRAFT_REVISER_SKILL_NAME = "DraftReviser";
const FINAL_RENDERER_SKILL_NAME = "FinalRenderer";

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
    await prisma.approvalPolicy.upsert({
      where: { skillName: REPORT_TYPE_ADVISOR_SKILL_NAME },
      update: { policyType: PolicyType.MANDATORY, confidenceThreshold: null },
      create: {
        skillName: REPORT_TYPE_ADVISOR_SKILL_NAME,
        policyType: PolicyType.MANDATORY,
      },
    });
    await prisma.approvalPolicy.upsert({
      where: { skillName: DRAFT_GENERATOR_SKILL_NAME },
      update: { policyType: PolicyType.MANDATORY, confidenceThreshold: null },
      create: {
        skillName: DRAFT_GENERATOR_SKILL_NAME,
        policyType: PolicyType.MANDATORY,
      },
    });
    await prisma.approvalPolicy.upsert({
      where: { skillName: DRAFT_QUALITY_PRECHECK_SKILL_NAME },
      update: { policyType: PolicyType.ADVISORY_ONLY, confidenceThreshold: null },
      create: {
        skillName: DRAFT_QUALITY_PRECHECK_SKILL_NAME,
        policyType: PolicyType.ADVISORY_ONLY,
      },
    });
    await prisma.approvalPolicy.upsert({
      where: { skillName: DRAFT_REVISER_SKILL_NAME },
      update: { policyType: PolicyType.MANDATORY, confidenceThreshold: null },
      create: {
        skillName: DRAFT_REVISER_SKILL_NAME,
        policyType: PolicyType.MANDATORY,
      },
    });
    await prisma.approvalPolicy.upsert({
      where: { skillName: FINAL_RENDERER_SKILL_NAME },
      update: { policyType: PolicyType.AUTO, confidenceThreshold: null },
      create: {
        skillName: FINAL_RENDERER_SKILL_NAME,
        policyType: PolicyType.AUTO,
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

  it("Merger routes purely on confidence vs. its own threshold when notes were provided", async () => {
    const auto = await resolvePolicy({
      skillName: MERGER_SKILL_NAME,
      result: { notes_provided: true },
      confidence: 0.85,
    });
    expect(auto.outcome).toBe("auto_approved");

    const low = await resolvePolicy({
      skillName: MERGER_SKILL_NAME,
      result: { notes_provided: true },
      confidence: 0.5,
    });
    expect(low.outcome).toBe("low_confidence");
  });

  // Phase 13: without notes there is nothing to reconcile between two
  // sources, so a low confidence score is not genuine merge uncertainty --
  // this must never open PENDING_HUMAN_CONFIRMATION, regardless of how low
  // the score is. See src/ai/skills/merger.ts's own comment on why
  // WITHOUT_NOTES_CONFIDENCE stays a low, threshold-crossing value anyway.
  it("Merger's semantic hook auto-approves unconditionally when notes were not provided, regardless of confidence", async () => {
    const resolution = await resolvePolicy({
      skillName: MERGER_SKILL_NAME,
      result: { notes_provided: false },
      confidence: 0.01,
    });
    expect(resolution.outcome).toBe("auto_approved");
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

  it("ReportTypeAdvisor's MANDATORY policy returns outcome 'mandatory' unconditionally, regardless of confidence", async () => {
    const high = await resolvePolicy({ skillName: REPORT_TYPE_ADVISOR_SKILL_NAME, result: {}, confidence: 0.99 });
    expect(high.outcome).toBe("mandatory");

    const low = await resolvePolicy({ skillName: REPORT_TYPE_ADVISOR_SKILL_NAME, result: {}, confidence: 0.01 });
    expect(low.outcome).toBe("mandatory");
  });

  it("DraftGenerator's MANDATORY policy returns outcome 'mandatory' unconditionally, regardless of confidence", async () => {
    const high = await resolvePolicy({ skillName: DRAFT_GENERATOR_SKILL_NAME, result: {}, confidence: 0.99 });
    expect(high.outcome).toBe("mandatory");

    const low = await resolvePolicy({ skillName: DRAFT_GENERATOR_SKILL_NAME, result: {}, confidence: 0.01 });
    expect(low.outcome).toBe("mandatory");
  });

  it("DraftQualityPrecheck's ADVISORY_ONLY policy returns outcome 'auto_approved' unconditionally, regardless of confidence", async () => {
    const high = await resolvePolicy({ skillName: DRAFT_QUALITY_PRECHECK_SKILL_NAME, result: {}, confidence: 0.99 });
    expect(high.outcome).toBe("auto_approved");

    const low = await resolvePolicy({ skillName: DRAFT_QUALITY_PRECHECK_SKILL_NAME, result: {}, confidence: 0.01 });
    expect(low.outcome).toBe("auto_approved");
  });

  it("DraftReviser's MANDATORY policy returns outcome 'mandatory' unconditionally, regardless of confidence", async () => {
    const high = await resolvePolicy({ skillName: DRAFT_REVISER_SKILL_NAME, result: {}, confidence: 0.99 });
    expect(high.outcome).toBe("mandatory");

    const low = await resolvePolicy({ skillName: DRAFT_REVISER_SKILL_NAME, result: {}, confidence: 0.01 });
    expect(low.outcome).toBe("mandatory");
  });

  it("FinalRenderer's AUTO policy returns outcome 'auto_approved' unconditionally, regardless of confidence", async () => {
    const high = await resolvePolicy({ skillName: FINAL_RENDERER_SKILL_NAME, result: {}, confidence: 0.99 });
    expect(high.outcome).toBe("auto_approved");

    const low = await resolvePolicy({ skillName: FINAL_RENDERER_SKILL_NAME, result: {}, confidence: 0.01 });
    expect(low.outcome).toBe("auto_approved");
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
