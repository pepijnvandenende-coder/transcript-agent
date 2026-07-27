import { randomUUID } from "node:crypto";
import { ActorType, ConflictStatus, JobStatus, JobType, PolicyType } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConflictDetectorEnvelope, MergerEnvelope, TranscriptQualityEnvelope } from "../../src/ai/skillEnvelope";
import { explainConflict, restartUpload } from "../../src/approval/conflictResolution";
import { handleSkillOutput } from "../../src/approval/gateway";
import { ConflictAlreadyResolvedError, ConflictNotFoundError, NotAtConflictReviewError } from "../../src/domain/types";
import { createConflicts } from "../../src/persistence/repositories/conflictRepository";
import { prisma } from "../../src/persistence/prismaClient";
import * as engine from "../../src/workflow/engine";
import { WorkflowState } from "../../src/workflow/states";

// Requires a real Postgres database -- see docs/phase-1/README.md.
const SKILL_NAME = "TranscriptQualityChecker";
const MERGER_SKILL_NAME = "Merger";
const CONFLICT_DETECTOR_SKILL_NAME = "ConflictDetector";

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

function conflictDetectorEnvelope(overrides: {
  confidence?: number;
  conflicts?: Array<{ description: string; source_b?: string }>;
} = {}): ConflictDetectorEnvelope {
  const { confidence = 0.9, conflicts = [] } = overrides;
  return {
    skill: CONFLICT_DETECTOR_SKILL_NAME,
    schema_version: "1.0.0",
    confidence,
    rationale: "test envelope",
    flags: [],
    result: { conflicts },
  };
}

describe("approval/conflictResolution", () => {
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

    const user = await prisma.user.create({
      data: { name: "Conflict Resolution Test User", email: `conflict-resolution-test-${randomUUID()}@example.com`, role: "reviewer" },
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
    await prisma.conflict.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.merge.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.aiOutput.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.transcript.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.note.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.workflow.deleteMany({ where: { createdById: userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  async function workflowAtConflictsPendingReview(title: string, conflictDescriptions: string[]) {
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
    const { aiOutputId } = await handleSkillOutput({
      workflowId: workflow.id,
      envelope: conflictDetectorEnvelope({
        confidence: 0.9,
        conflicts: conflictDescriptions.map((description) => ({ description })),
      }),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });
    // handleSkillOutput() never writes skill-specific rows itself (mirrors
    // Merger/`merges` -- see mergeRunner.ts) -- conflictDetectionRunner.ts
    // does this in the real flow; these tests call handleSkillOutput()
    // directly (bypassing the job queue), so it's done here instead.
    await createConflicts({
      workflowId: workflow.id,
      aiOutputId,
      conflicts: conflictDescriptions.map((description) => ({ description })),
    });
    const conflicts = await prisma.conflict.findMany({ where: { aiOutputId }, orderBy: { createdAt: "asc" } });
    return { workflowId: workflow.id, aiOutputId, conflicts };
  }

  it("does not advance the workflow until every open conflict is explained, then auto-enqueues a fresh MERGE job", async () => {
    const { workflowId, aiOutputId, conflicts } = await workflowAtConflictsPendingReview(
      "ConflictResolution Two Conflicts",
      ["conflict A", "conflict B"],
    );
    expect(conflicts).toHaveLength(2);

    const first = await explainConflict({
      workflowId,
      conflictId: conflicts[0].id,
      actorId: userId,
      explanation: "resolved A",
    });
    expect(first.workflow).toBeNull();
    let reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId } });
    expect(reloaded.currentState).toBe(WorkflowState.CONFLICTS_PENDING_REVIEW);

    const second = await explainConflict({
      workflowId,
      conflictId: conflicts[1].id,
      actorId: userId,
      explanation: "resolved B",
    });
    expect(second.workflow).not.toBeNull();
    expect(second.workflow!.currentState).toBe(WorkflowState.MERGING);

    reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId } });
    expect(reloaded.currentState).toBe(WorkflowState.MERGING);

    // enqueueForStateEntry (shared with Phase 3) restarts the Merger job.
    const mergeJob = await prisma.job.findFirstOrThrow({ where: { workflowId, jobType: JobType.MERGE } });
    expect(mergeJob.status).toBe(JobStatus.QUEUED);

    const conflictAiOutput = await prisma.aiOutput.findUniqueOrThrow({ where: { id: aiOutputId } });
    expect(conflictAiOutput.approvalStatus).toBe("HUMAN_APPROVED");
    expect(conflictAiOutput.approvedById).toBe(userId);
  });

  it("rejects explaining an already-resolved conflict", async () => {
    // Needs a second still-open conflict so the workflow stays at
    // CONFLICTS_PENDING_REVIEW after the first explain -- otherwise the
    // first call is the last conflict, the workflow advances, and
    // re-explaining would correctly fail with NotAtConflictReviewError instead.
    const { workflowId, conflicts } = await workflowAtConflictsPendingReview(
      "ConflictResolution Already Resolved",
      ["first conflict", "second conflict"],
    );
    await explainConflict({ workflowId, conflictId: conflicts[0].id, actorId: userId, explanation: "resolved" });

    await expect(
      explainConflict({ workflowId, conflictId: conflicts[0].id, actorId: userId, explanation: "again" }),
    ).rejects.toBeInstanceOf(ConflictAlreadyResolvedError);
  });

  it("rejects a conflictId that doesn't belong to the workflow", async () => {
    const { workflowId } = await workflowAtConflictsPendingReview("ConflictResolution Unknown Conflict", [
      "a conflict",
    ]);

    await expect(
      explainConflict({ workflowId, conflictId: randomUUID(), actorId: userId, explanation: "x" }),
    ).rejects.toBeInstanceOf(ConflictNotFoundError);
  });

  it("rejects explain/restart when the workflow is not at CONFLICTS_PENDING_REVIEW", async () => {
    const workflow = await engine.createWorkflow({ title: "ConflictResolution Not At Review", createdById: userId });

    await expect(restartUpload({ workflowId: workflow.id, actorId: userId })).rejects.toBeInstanceOf(
      NotAtConflictReviewError,
    );
    await expect(
      explainConflict({ workflowId: workflow.id, conflictId: randomUUID(), actorId: userId, explanation: "x" }),
    ).rejects.toBeInstanceOf(NotAtConflictReviewError);
  });

  it("restartUpload supersedes open conflicts (never deletes them) and rewinds to TRANSCRIPT_UPLOADED", async () => {
    const { workflowId, conflicts } = await workflowAtConflictsPendingReview("ConflictResolution Restart", [
      "conflict to abandon",
    ]);

    const updated = await restartUpload({ workflowId, actorId: userId });
    expect(updated.currentState).toBe(WorkflowState.TRANSCRIPT_UPLOADED);

    const reloadedConflict = await prisma.conflict.findUniqueOrThrow({ where: { id: conflicts[0].id } });
    expect(reloadedConflict.status).toBe(ConflictStatus.RESOLVED);
    expect(reloadedConflict.resolution).toBe("superseded_by_restart");
    expect(reloadedConflict.resolvedById).toBe(userId);
  });
});
