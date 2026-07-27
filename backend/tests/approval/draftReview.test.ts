import { randomUUID } from "node:crypto";
import { ActorType, PolicyType } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ConflictDetectorEnvelope,
  DraftGeneratorEnvelope,
  DraftQualityPrecheckEnvelope,
  DraftReviserEnvelope,
  MergerEnvelope,
  ReportTypeAdvisorEnvelope,
  TranscriptQualityEnvelope,
} from "../../src/ai/skillEnvelope";
import { approveDraft, requestDraftChanges } from "../../src/approval/draftReview";
import { handleSkillOutput } from "../../src/approval/gateway";
import { DraftVersionMismatchError, NotAtDraftReviewError } from "../../src/domain/types";
import { createDraftVersion } from "../../src/persistence/repositories/draftRepository";
import { findFeedbackForDraft } from "../../src/persistence/repositories/reviewFeedbackRepository";
import { prisma } from "../../src/persistence/prismaClient";
import * as engine from "../../src/workflow/engine";
import { WorkflowState } from "../../src/workflow/states";

// Requires a real Postgres database -- see docs/phase-1/README.md.
const SKILL_NAME = "TranscriptQualityChecker";
const MERGER_SKILL_NAME = "Merger";
const CONFLICT_DETECTOR_SKILL_NAME = "ConflictDetector";
const REPORT_TYPE_ADVISOR_SKILL_NAME = "ReportTypeAdvisor";
const DRAFT_GENERATOR_SKILL_NAME = "DraftGenerator";
const DRAFT_QUALITY_PRECHECK_SKILL_NAME = "DraftQualityPrecheck";
const DRAFT_REVISER_SKILL_NAME = "DraftReviser";

function envelope(overrides: { confidence?: number } = {}): TranscriptQualityEnvelope {
  const { confidence = 0.95 } = overrides;
  return {
    skill: SKILL_NAME,
    schema_version: "1.0.0",
    confidence,
    rationale: "test envelope",
    flags: [],
    result: { sufficient: true, issues: [], metrics: {} },
  };
}

function mergerEnvelope(overrides: { confidence?: number } = {}): MergerEnvelope {
  const { confidence = 0.95 } = overrides;
  return {
    skill: MERGER_SKILL_NAME,
    schema_version: "1.0.0",
    confidence,
    rationale: "test envelope",
    flags: [],
    result: {
      merged_sections: [{ heading: "Transcript", content: "x", source: "transcript" }],
      unmatched_notes: [],
      notes_provided: true,
    },
  };
}

function conflictDetectorEnvelope(overrides: { confidence?: number } = {}): ConflictDetectorEnvelope {
  const { confidence = 0.9 } = overrides;
  return {
    skill: CONFLICT_DETECTOR_SKILL_NAME,
    schema_version: "1.0.0",
    confidence,
    rationale: "test envelope",
    flags: [],
    result: { conflicts: [] },
  };
}

function reportTypeAdvisorEnvelope(overrides: { confidence?: number } = {}): ReportTypeAdvisorEnvelope {
  const { confidence = 0.85 } = overrides;
  return {
    skill: REPORT_TYPE_ADVISOR_SKILL_NAME,
    schema_version: "1.0.0",
    confidence,
    rationale: "test envelope",
    flags: [],
    result: { suggested_type: "Standard Audit Summary", rationale: "test rationale", runner_up: "Incident Report" },
  };
}

function draftGeneratorEnvelope(overrides: { confidence?: number } = {}): DraftGeneratorEnvelope {
  const { confidence = 0.8 } = overrides;
  return {
    skill: DRAFT_GENERATOR_SKILL_NAME,
    schema_version: "1.0.0",
    confidence,
    rationale: "test envelope",
    flags: [],
    result: {
      report_type: "thematic",
      title: "Gespreksverslag Test",
      attendees: [],
      date: "2026-01-01",
      subject: "Test",
      sections: [
        { heading: "Samenvatting", content: "x" },
        { heading: "Notulen", content: "y" },
      ],
      coverage: 0.7,
    },
  };
}

function draftQualityPrecheckEnvelope(overrides: { confidence?: number } = {}): DraftQualityPrecheckEnvelope {
  const { confidence = 1 } = overrides;
  return {
    skill: DRAFT_QUALITY_PRECHECK_SKILL_NAME,
    schema_version: "1.0.0",
    confidence,
    rationale: "test envelope",
    flags: [],
    result: {
      overall_score: 1,
      checklist: [
        { item: "Samenvatting", passed: true },
        { item: "Notulen", passed: true },
      ],
      blocking_issues: [],
      recommendation: "Looks complete.",
    },
  };
}

function draftReviserEnvelope(sections: DraftGeneratorEnvelope["result"]["sections"]): DraftReviserEnvelope {
  return {
    skill: DRAFT_REVISER_SKILL_NAME,
    schema_version: "1.0.0",
    confidence: 0.8,
    rationale: "test envelope",
    flags: [],
    result: {
      sections,
      changes_applied: ["Aanvulling naar aanleiding van reviewer-feedback: test"],
      unresolved_feedback: [],
    },
  };
}

describe("approval/draftReview", () => {
  let userId: string;

  beforeAll(async () => {
    await prisma.approvalPolicy.upsert({
      where: { skillName: SKILL_NAME },
      update: { policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.75 },
      create: { skillName: SKILL_NAME, policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.75 },
    });
    await prisma.approvalPolicy.upsert({
      where: { skillName: MERGER_SKILL_NAME },
      update: { policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.8 },
      create: { skillName: MERGER_SKILL_NAME, policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.8 },
    });
    await prisma.approvalPolicy.upsert({
      where: { skillName: CONFLICT_DETECTOR_SKILL_NAME },
      update: { policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.7 },
      create: { skillName: CONFLICT_DETECTOR_SKILL_NAME, policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.7 },
    });
    await prisma.approvalPolicy.upsert({
      where: { skillName: REPORT_TYPE_ADVISOR_SKILL_NAME },
      update: { policyType: PolicyType.MANDATORY, confidenceThreshold: null },
      create: { skillName: REPORT_TYPE_ADVISOR_SKILL_NAME, policyType: PolicyType.MANDATORY },
    });
    await prisma.approvalPolicy.upsert({
      where: { skillName: DRAFT_GENERATOR_SKILL_NAME },
      update: { policyType: PolicyType.MANDATORY, confidenceThreshold: null },
      create: { skillName: DRAFT_GENERATOR_SKILL_NAME, policyType: PolicyType.MANDATORY },
    });
    await prisma.approvalPolicy.upsert({
      where: { skillName: DRAFT_QUALITY_PRECHECK_SKILL_NAME },
      update: { policyType: PolicyType.ADVISORY_ONLY, confidenceThreshold: null },
      create: { skillName: DRAFT_QUALITY_PRECHECK_SKILL_NAME, policyType: PolicyType.ADVISORY_ONLY },
    });
    await prisma.approvalPolicy.upsert({
      where: { skillName: DRAFT_REVISER_SKILL_NAME },
      update: { policyType: PolicyType.MANDATORY, confidenceThreshold: null },
      create: { skillName: DRAFT_REVISER_SKILL_NAME, policyType: PolicyType.MANDATORY },
    });
    await prisma.reportTypePolicy.upsert({
      where: { key: "thematic" },
      update: {},
      create: {
        key: "thematic",
        displayName: "Thematisch gespreksverslag",
        language: "nl",
        promptVersion: "v1",
        promptRef: "thematic.md",
        requiredSections: ["Samenvatting"],
        optionalSections: [],
        bodyContentRule: { type: "topic_sections", minCount: 1 },
      },
    });

    const user = await prisma.user.create({
      data: { name: "Draft Review Test User", email: `draft-review-test-${randomUUID()}@example.com`, role: "reviewer" },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.stateTransition.deleteMany({
      where: { OR: [{ actorId: userId }, { workflow: { createdById: userId } }] },
    });
    await prisma.approvalRequest.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.job.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.aiOutputInput.deleteMany({ where: { aiOutput: { workflow: { createdById: userId } } } });
    await prisma.reviewFeedback.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.draftPrecheck.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.reportTypeSuggestion.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.draft.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.conflict.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.merge.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.aiOutput.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.transcript.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.workflow.deleteMany({ where: { createdById: userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  async function workflowAtDraftPendingReview(title: string) {
    const workflow = await engine.createWorkflow({ title, createdById: userId });
    await engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "upload_transcript" },
      actor: { actorType: ActorType.USER, actorId: userId },
    });
    await engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "submit_for_validation" },
      actor: { actorType: ActorType.USER, actorId: userId },
    });
    await handleSkillOutput({
      workflowId: workflow.id,
      envelope: envelope({ confidence: 0.95 }),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });
    await handleSkillOutput({
      workflowId: workflow.id,
      envelope: mergerEnvelope({ confidence: 0.95 }),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });
    await handleSkillOutput({
      workflowId: workflow.id,
      envelope: conflictDetectorEnvelope({ confidence: 0.9 }),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });
    await handleSkillOutput({
      workflowId: workflow.id,
      envelope: reportTypeAdvisorEnvelope({ confidence: 0.85 }),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });
    await engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "select_report_type" },
      actor: { actorType: ActorType.USER, actorId: userId },
    });
    const { aiOutputId: draftAiOutputId } = await handleSkillOutput({
      workflowId: workflow.id,
      envelope: draftGeneratorEnvelope(),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });
    // handleSkillOutput() never writes skill-specific rows itself (mirrors
    // Merger/ReportTypeAdvisor -- see draftGenerationRunner.ts). This test
    // calls handleSkillOutput() directly (bypassing the job queue), so it's
    // done here instead.
    const draft = await createDraftVersion({
      workflowId: workflow.id,
      aiOutputId: draftAiOutputId,
      reportType: "thematic",
      title: "Gespreksverslag Test",
      attendees: [],
      date: "2026-01-01",
      subject: "Test",
      sections: [
        { heading: "Samenvatting", content: "x" },
        { heading: "Notulen", content: "y" },
      ],
      coverage: 0.7,
    });
    await handleSkillOutput({
      workflowId: workflow.id,
      envelope: draftQualityPrecheckEnvelope(),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });
    return { workflowId: workflow.id, draft };
  }

  it("approveDraft marks the draft's ai_output HUMAN_APPROVED and advances to GENERATING_FINAL", async () => {
    const { workflowId, draft } = await workflowAtDraftPendingReview("Draft Review Approve");

    const updated = await approveDraft({ workflowId, actorId: userId, version: draft.version });
    expect(updated.currentState).toBe(WorkflowState.GENERATING_FINAL);

    const aiOutput = await prisma.aiOutput.findUniqueOrThrow({ where: { id: draft.aiOutputId } });
    expect(aiOutput.approvalStatus).toBe("HUMAN_APPROVED");
    expect(aiOutput.approvedById).toBe(userId);
  });

  it("requestDraftChanges writes a review_feedback row and advances to REVISING_DRAFT", async () => {
    const { workflowId, draft } = await workflowAtDraftPendingReview("Draft Review Request Changes");

    const updated = await requestDraftChanges({
      workflowId,
      actorId: userId,
      version: draft.version,
      feedback: "Please expand the Notulen section.",
    });
    expect(updated.currentState).toBe(WorkflowState.REVISING_DRAFT);

    const feedback = await findFeedbackForDraft(draft.id);
    expect(feedback).toHaveLength(1);
    expect(feedback[0].feedback).toBe("Please expand the Notulen section.");
    expect(feedback[0].createdById).toBe(userId);

    // Unlike approveDraft, the draft's own ai_output is not finalized -- it's
    // being revised, not accepted.
    const aiOutput = await prisma.aiOutput.findUniqueOrThrow({ where: { id: draft.aiOutputId } });
    expect(aiOutput.approvalStatus).toBe("PENDING");
  });

  it("rejects both actions when the workflow is not at DRAFT_PENDING_REVIEW", async () => {
    const workflow = await engine.createWorkflow({ title: "Draft Review Not At Checkpoint", createdById: userId });

    await expect(approveDraft({ workflowId: workflow.id, actorId: userId, version: 1 })).rejects.toBeInstanceOf(
      NotAtDraftReviewError,
    );
    await expect(
      requestDraftChanges({ workflowId: workflow.id, actorId: userId, version: 1, feedback: "x" }),
    ).rejects.toBeInstanceOf(NotAtDraftReviewError);
  });

  it("rejects both actions when the given version isn't the current latest draft", async () => {
    const { workflowId } = await workflowAtDraftPendingReview("Draft Review Stale Version");

    await expect(approveDraft({ workflowId, actorId: userId, version: 999 })).rejects.toBeInstanceOf(
      DraftVersionMismatchError,
    );
    await expect(
      requestDraftChanges({ workflowId, actorId: userId, version: 999, feedback: "x" }),
    ).rejects.toBeInstanceOf(DraftVersionMismatchError);
  });

  it("supports a second revision round-trip: after DraftReviser produces v2, approveDraft/requestDraftChanges work against it unmodified", async () => {
    const { workflowId, draft } = await workflowAtDraftPendingReview("Draft Review Second Round Trip");

    await requestDraftChanges({
      workflowId,
      actorId: userId,
      version: draft.version,
      feedback: "Please expand the Notulen section.",
    });

    // handleSkillOutput() never writes skill-specific rows itself -- this
    // test calls it directly (bypassing the job queue/draftReviserRunner.ts),
    // so the new Draft version is created here instead, mirroring
    // workflowAtDraftPendingReview's own DraftGenerator step above.
    const revisedSections = [
      { heading: "Samenvatting", content: "x" },
      { heading: "Notulen", content: "y\n\nAanvulling naar aanleiding van reviewer-feedback: expanded" },
    ];
    const { aiOutputId: revisedAiOutputId } = await handleSkillOutput({
      workflowId,
      envelope: draftReviserEnvelope(revisedSections),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });
    const revisedDraft = await createDraftVersion({
      workflowId,
      aiOutputId: revisedAiOutputId,
      reportType: draft.reportType,
      title: draft.title,
      attendees: draft.attendees as unknown as string[],
      date: draft.date,
      subject: draft.subject,
      sections: revisedSections,
      coverage: draft.coverage ?? undefined,
    });
    expect(revisedDraft.version).toBe(draft.version + 1);

    await handleSkillOutput({
      workflowId,
      envelope: draftQualityPrecheckEnvelope(),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });

    // Unmodified approveDraft() -- generic over "whichever draft is latest" --
    // now approves v2 with no code changes needed for this second round.
    const updated = await approveDraft({ workflowId, actorId: userId, version: revisedDraft.version });
    expect(updated.currentState).toBe(WorkflowState.GENERATING_FINAL);

    const aiOutput = await prisma.aiOutput.findUniqueOrThrow({ where: { id: revisedDraft.aiOutputId } });
    expect(aiOutput.approvalStatus).toBe("HUMAN_APPROVED");
  });
});
