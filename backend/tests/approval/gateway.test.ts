import { randomUUID } from "node:crypto";
import { ActorType, JobStatus, JobType, PolicyType, RetryMode } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MergerEnvelope, TranscriptQualityEnvelope } from "../../src/ai/skillEnvelope";
import {
  confirmApprovalRequest,
  editRetryApprovalRequest,
  handleSkillOutput,
  retryApprovalRequest,
} from "../../src/approval/gateway";
import { InvalidRetryInputError, MaxRetriesExceededError, NotAtCheckpointError } from "../../src/domain/types";
import { prisma } from "../../src/persistence/prismaClient";
import * as engine from "../../src/workflow/engine";
import { WorkflowState } from "../../src/workflow/states";

// Requires a real Postgres database -- see docs/phase-1/README.md.
const SKILL_NAME = "TranscriptQualityChecker";
const MERGER_SKILL_NAME = "Merger";

function envelope(
  overrides: { confidence?: number; sufficient?: boolean; issues?: string[] } = {},
): TranscriptQualityEnvelope {
  const { confidence = 0.95, sufficient = true, issues = [] } = overrides;
  return {
    skill: SKILL_NAME,
    schema_version: "1.0.0",
    confidence,
    rationale: "test envelope",
    flags: [],
    result: { sufficient, issues, metrics: {} },
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
    },
  };
}

describe("approval/gateway", () => {
  let userId: string;

  beforeAll(async () => {
    await prisma.approvalPolicy.upsert({
      where: { skillName: SKILL_NAME },
      update: { policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.75, maxRetries: 5 },
      create: { skillName: SKILL_NAME, policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.75 },
    });
    await prisma.approvalPolicy.upsert({
      where: { skillName: MERGER_SKILL_NAME },
      update: { policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.8, maxRetries: 5 },
      create: { skillName: MERGER_SKILL_NAME, policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.8 },
    });

    const user = await prisma.user.create({
      data: { name: "Gateway Test User", email: `gateway-test-${randomUUID()}@example.com`, role: "reviewer" },
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
    await prisma.merge.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.aiOutput.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.transcript.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.note.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.workflow.deleteMany({ where: { createdById: userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  async function workflowAtValidating(title: string) {
    const workflow = await engine.createWorkflow({ title, createdById: userId });
    await engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "upload_transcript" },
      actor: { actorType: ActorType.USER, actorId: userId },
    });
    return engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "submit_for_validation" },
      actor: { actorType: ActorType.USER, actorId: userId },
    });
  }

  it("auto-approves a high-confidence, sufficient result and advances to MERGING", async () => {
    const workflow = await workflowAtValidating("Gateway Auto Approve");

    await handleSkillOutput({
      workflowId: workflow.id,
      envelope: envelope({ confidence: 0.95 }),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });

    const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
    expect(reloaded.currentState).toBe(WorkflowState.MERGING);

    const aiOutput = await prisma.aiOutput.findFirstOrThrow({ where: { workflowId: workflow.id } });
    expect(aiOutput.approvalStatus).toBe("AUTO_APPROVED");
    expect(aiOutput.policyApplied).toBe("AUTO_IF_ABOVE");
    expect(aiOutput.validationStatus).toBe("VALID");
    expect(aiOutput.attemptNumber).toBe(1);
  });

  it("auto-approving into MERGING auto-enqueues a MERGE job (no separate start-merge action)", async () => {
    const workflow = await workflowAtValidating("Gateway Auto Enqueue Merge");

    await handleSkillOutput({
      workflowId: workflow.id,
      envelope: envelope({ confidence: 0.95 }),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });

    const job = await prisma.job.findFirstOrThrow({ where: { workflowId: workflow.id, jobType: JobType.MERGE } });
    expect(job.status).toBe(JobStatus.QUEUED);
    expect(job.retryOfAiOutputId).toBeNull();
  });

  it("routes sufficient=false straight to TRANSCRIPT_INSUFFICIENT regardless of confidence", async () => {
    const workflow = await workflowAtValidating("Gateway Insufficient");

    await handleSkillOutput({
      workflowId: workflow.id,
      envelope: envelope({ confidence: 0.99, sufficient: false, issues: ["transcript_empty"] }),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });

    const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
    expect(reloaded.currentState).toBe(WorkflowState.TRANSCRIPT_INSUFFICIENT);
  });

  it("opens PENDING_HUMAN_CONFIRMATION on low confidence, and confirm (no AI re-run) advances to MERGING", async () => {
    const workflow = await workflowAtValidating("Gateway Low Confidence");

    await handleSkillOutput({
      workflowId: workflow.id,
      envelope: envelope({ confidence: 0.5 }),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });

    let reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
    expect(reloaded.currentState).toBe(WorkflowState.PENDING_HUMAN_CONFIRMATION);

    const openRequest = await prisma.approvalRequest.findFirstOrThrow({ where: { workflowId: workflow.id } });
    expect(openRequest.status).toBe("PENDING");
    expect(openRequest.attemptCount).toBe(1);
    const aiOutputCountBefore = await prisma.aiOutput.count({ where: { workflowId: workflow.id } });

    reloaded = await confirmApprovalRequest({ workflowId: workflow.id, actorId: userId });
    expect(reloaded.currentState).toBe(WorkflowState.MERGING);

    // Confirm must not have re-run the skill -- no new ai_outputs row.
    const aiOutputCountAfter = await prisma.aiOutput.count({ where: { workflowId: workflow.id } });
    expect(aiOutputCountAfter).toBe(aiOutputCountBefore);

    const resolvedRequest = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: openRequest.id } });
    expect(resolvedRequest.status).toBe("RESOLVED");
    expect(resolvedRequest.resolution).toBe("confirmed");

    const aiOutput = await prisma.aiOutput.findUniqueOrThrow({ where: { id: openRequest.aiOutputId } });
    expect(aiOutput.approvalStatus).toBe("HUMAN_APPROVED");
    expect(aiOutput.approvedById).toBe(userId);
  });

  it("opens PENDING_HUMAN_CONFIRMATION on schema-invalid output", async () => {
    const workflow = await workflowAtValidating("Gateway Schema Invalid");

    const invalidEnvelope = { ...envelope(), confidence: 5 }; // out of [0,1] range -> fails schema

    await handleSkillOutput({
      workflowId: workflow.id,
      envelope: invalidEnvelope,
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });

    const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
    expect(reloaded.currentState).toBe(WorkflowState.PENDING_HUMAN_CONFIRMATION);

    const aiOutput = await prisma.aiOutput.findFirstOrThrow({ where: { workflowId: workflow.id } });
    expect(aiOutput.validationStatus).toBe("INVALID");
    expect(aiOutput.validationErrors).not.toBeNull();
  });

  it("refuses to confirm a workflow that is not at PENDING_HUMAN_CONFIRMATION", async () => {
    const workflow = await workflowAtValidating("Gateway Not At Checkpoint");

    await handleSkillOutput({
      workflowId: workflow.id,
      envelope: envelope({ confidence: 0.95 }),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });
    // workflow is now at MERGING (auto-approved), not a checkpoint.

    await expect(confirmApprovalRequest({ workflowId: workflow.id, actorId: userId })).rejects.toBeInstanceOf(
      NotAtCheckpointError,
    );
    await expect(retryApprovalRequest({ workflowId: workflow.id, actorId: userId })).rejects.toBeInstanceOf(
      NotAtCheckpointError,
    );
  });

  describe("Merger routing (MERGING -> DETECTING_CONFLICTS)", () => {
    async function workflowAtMerging(title: string) {
      const workflow = await workflowAtValidating(title);
      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: envelope({ confidence: 0.95 }),
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });
      return prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
    }

    it("auto-approves a high-confidence Merger result and advances to DETECTING_CONFLICTS", async () => {
      const workflow = await workflowAtMerging("Gateway Merger Auto Approve");

      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: mergerEnvelope({ confidence: 0.95 }),
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });

      const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
      expect(reloaded.currentState).toBe(WorkflowState.DETECTING_CONFLICTS);
    });

    it("opens PENDING_HUMAN_CONFIRMATION on low Merger confidence", async () => {
      const workflow = await workflowAtMerging("Gateway Merger Low Confidence");

      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: mergerEnvelope({ confidence: 0.3 }),
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });

      const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
      expect(reloaded.currentState).toBe(WorkflowState.PENDING_HUMAN_CONFIRMATION);
    });

    it("opens PENDING_HUMAN_CONFIRMATION on schema-invalid Merger output", async () => {
      const workflow = await workflowAtMerging("Gateway Merger Schema Invalid");

      const invalid = { ...mergerEnvelope(), confidence: -1 };

      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: invalid,
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });

      const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
      expect(reloaded.currentState).toBe(WorkflowState.PENDING_HUMAN_CONFIRMATION);
    });
  });

  describe("retry / edit-retry at PENDING_HUMAN_CONFIRMATION", () => {
    async function workflowAtCheckpoint(title: string) {
      const workflow = await workflowAtValidating(title);
      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: envelope({ confidence: 0.5 }),
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });
      const openRequest = await prisma.approvalRequest.findFirstOrThrow({ where: { workflowId: workflow.id } });
      return { workflowId: workflow.id, openRequest };
    }

    it("retry routes back through the originating PROCESSING state and enqueues a SAME_INPUT job", async () => {
      const { workflowId, openRequest } = await workflowAtCheckpoint("Gateway Retry");

      const updated = await retryApprovalRequest({ workflowId, actorId: userId, reviewerComment: "try again" });
      expect(updated.currentState).toBe(WorkflowState.VALIDATING_TRANSCRIPT);

      const resolvedRequest = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: openRequest.id } });
      expect(resolvedRequest.status).toBe("RESOLVED");
      expect(resolvedRequest.resolution).toBe("retried");

      const oldOutput = await prisma.aiOutput.findUniqueOrThrow({ where: { id: openRequest.aiOutputId } });
      expect(oldOutput.reviewerComment).toBe("try again");

      const job = await prisma.job.findFirstOrThrow({
        where: { workflowId, jobType: JobType.VALIDATE_TRANSCRIPT, retryOfAiOutputId: openRequest.aiOutputId },
      });
      expect(job.retryMode).toBe(RetryMode.SAME_INPUT);

      // Simulate the runner completing the retried job: attempt_number
      // increments from the output being retried, and lineage is recorded.
      const { aiOutputId } = await handleSkillOutput({
        workflowId,
        envelope: envelope({ confidence: 0.95 }),
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
        retryOfAiOutputId: openRequest.aiOutputId,
        retryMode: RetryMode.SAME_INPUT,
      });
      const newOutput = await prisma.aiOutput.findUniqueOrThrow({ where: { id: aiOutputId } });
      expect(newOutput.attemptNumber).toBe(2);
      expect(newOutput.retryOfAiOutputId).toBe(openRequest.aiOutputId);
      expect(newOutput.retryMode).toBe(RetryMode.SAME_INPUT);
    });

    it("edit-retry records a new transcript version and enqueues an EDITED_INPUT job", async () => {
      const { workflowId, openRequest } = await workflowAtCheckpoint("Gateway Edit Retry");

      const updated = await editRetryApprovalRequest({
        workflowId,
        actorId: userId,
        transcriptContent: "an edited transcript with new content",
      });
      expect(updated.currentState).toBe(WorkflowState.VALIDATING_TRANSCRIPT);

      const transcripts = await prisma.transcript.findMany({ where: { workflowId }, orderBy: { version: "asc" } });
      expect(transcripts).toHaveLength(1);
      expect(transcripts[0].version).toBe(1);

      const resolvedRequest = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: openRequest.id } });
      expect(resolvedRequest.resolution).toBe("edited_input");

      const job = await prisma.job.findFirstOrThrow({
        where: { workflowId, jobType: JobType.VALIDATE_TRANSCRIPT, retryOfAiOutputId: openRequest.aiOutputId },
      });
      expect(job.retryMode).toBe(RetryMode.EDITED_INPUT);
    });

    it("edit-retry rejects an input type the checkpoint's skill doesn't consume", async () => {
      const { workflowId } = await workflowAtCheckpoint("Gateway Edit Retry Invalid Input");

      await expect(
        editRetryApprovalRequest({ workflowId, actorId: userId, notesContent: "notes TranscriptQualityChecker never reads" }),
      ).rejects.toBeInstanceOf(InvalidRetryInputError);
    });

    it("blocks retry once the episode's attemptCount reaches the skill's maxRetries", async () => {
      await prisma.approvalPolicy.update({ where: { skillName: SKILL_NAME }, data: { maxRetries: 1 } });
      try {
        const { workflowId } = await workflowAtCheckpoint("Gateway Max Retries");

        await expect(retryApprovalRequest({ workflowId, actorId: userId })).rejects.toBeInstanceOf(
          MaxRetriesExceededError,
        );
      } finally {
        await prisma.approvalPolicy.update({ where: { skillName: SKILL_NAME }, data: { maxRetries: 5 } });
      }
    });
  });
});
