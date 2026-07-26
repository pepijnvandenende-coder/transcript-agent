import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { ActorType, JobStatus, JobType, PolicyType } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { retryApprovalRequest } from "../../src/approval/gateway";
import { env } from "../../src/config/env";
import { enqueue } from "../../src/jobs/queue";
import { processNextJob } from "../../src/jobs/worker";
import { prisma } from "../../src/persistence/prismaClient";
import { createNoteVersion } from "../../src/persistence/repositories/noteRepository";
import { createTranscriptVersion } from "../../src/persistence/repositories/transcriptRepository";
import * as engine from "../../src/workflow/engine";
import { WorkflowState } from "../../src/workflow/states";

// Requires a real Postgres database -- see docs/phase-1/README.md.
const SKILL_NAME = "TranscriptQualityChecker";
const MERGER_SKILL_NAME = "Merger";

// claimNextQueuedJob() claims the globally oldest QUEUED job across every
// workflow, not just this test's own -- and other test files (e.g.
// gateway.test.ts, which enqueues jobs via auto-enqueue-on-state-entry but
// deliberately never processes them) run concurrently against the same
// database. Rather than assume a single processNextJob() call claims a
// specific job, poll until that job leaves QUEUED, tolerating unrelated jobs
// being claimed and processed (successfully or not) along the way. A single
// `false` result from processNextJob() is NOT treated as "queue is
// permanently empty" -- claimNextQueuedJob()'s own optimistic-lock retry
// contract (see persistence/repositories/jobRepository.ts) can legitimately
// return null on a lost claim race even when other QUEUED rows (including
// this one) still exist, so this keeps polling up to maxAttempts regardless.
async function processUntilSettled(jobId: string, maxAttempts = 50): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    if (job.status !== JobStatus.QUEUED) return;
    const didWork = await processNextJob();
    if (!didWork) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

describe("jobs: queue + processNextJob (no daemon required)", () => {
  let userId: string;
  let workflowId: string;

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

    const user = await prisma.user.create({
      data: { name: "Worker Test User", email: `worker-test-${randomUUID()}@example.com`, role: "reviewer" },
    });
    userId = user.id;

    const workflow = await engine.createWorkflow({ title: "Worker Test Workflow", createdById: userId });
    workflowId = workflow.id;
    await engine.transition({
      workflowId,
      trigger: { kind: "user_action", action: "upload_transcript" },
      actor: { actorType: ActorType.USER, actorId: userId },
    });
    await engine.transition({
      workflowId,
      trigger: { kind: "user_action", action: "submit_for_validation" },
      actor: { actorType: ActorType.USER, actorId: userId },
    });
  });

  afterAll(async () => {
    // Jobs and ai_outputs reference each other (jobs.result_ai_output_id <->
    // ai_outputs.job_id, jobs.retry_of_ai_output_id), and ai_output_inputs
    // references ai_outputs too, so all three are cleared before ai_outputs
    // rows are deleted.
    await prisma.stateTransition.deleteMany({ where: { OR: [{ actorId: userId }, { workflowId }] } });
    await prisma.approvalRequest.deleteMany({ where: { workflowId } });
    await prisma.job.updateMany({ where: { workflowId }, data: { resultAiOutputId: null, retryOfAiOutputId: null } });
    await prisma.merge.deleteMany({ where: { workflowId } });
    await prisma.aiOutputInput.deleteMany({ where: { aiOutput: { workflowId } } });
    await prisma.aiOutput.deleteMany({ where: { workflowId } });
    await prisma.job.deleteMany({ where: { workflowId } });
    await prisma.transcript.deleteMany({ where: { workflowId } });
    await prisma.note.deleteMany({ where: { workflowId } });
    await prisma.workflow.delete({ where: { id: workflowId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
    rmSync(path.resolve(env.storageRootDir, workflowId), { recursive: true, force: true });
  });

  it("processNextJob claims, runs, and completes a queued VALIDATE_TRANSCRIPT job", async () => {
    const transcript = await createTranscriptVersion({
      workflowId,
      uploadedById: userId,
      content: "this transcript has plenty of words in it",
    });
    await createNoteVersion({ workflowId, uploadedById: userId, content: "some corroborating notes" });

    const job = await enqueue({ workflowId, jobType: JobType.VALIDATE_TRANSCRIPT, inputRef: transcript.id });
    expect(job.status).toBe(JobStatus.QUEUED);

    await processUntilSettled(job.id);

    const completed = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(completed.status).toBe(JobStatus.SUCCEEDED);
    expect(completed.resultAiOutputId).not.toBeNull();

    const workflow = await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId } });
    expect(workflow.currentState).toBe(WorkflowState.MERGING);
  });

  it("auto-approving VALIDATE_TRANSCRIPT auto-enqueued a MERGE job, which processNextJob also completes", async () => {
    // Continues from the previous test: entering MERGING auto-enqueued this
    // job via approval/gateway.ts's enqueueForStateEntry -- no explicit
    // "start merge" call is needed.
    const queuedMerge = await prisma.job.findFirstOrThrow({
      where: { workflowId, jobType: JobType.MERGE },
      orderBy: { createdAt: "desc" },
    });

    await processUntilSettled(queuedMerge.id);

    const completed = await prisma.job.findUniqueOrThrow({ where: { id: queuedMerge.id } });
    expect(completed.status).toBe(JobStatus.SUCCEEDED);
    expect(completed.resultAiOutputId).not.toBeNull();

    const workflow = await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId } });
    expect(workflow.currentState).toBe(WorkflowState.DETECTING_CONFLICTS);

    const merge = await prisma.merge.findFirstOrThrow({ where: { workflowId } });
    expect(merge.version).toBe(1);
    expect(merge.aiOutputId).toBe(completed.resultAiOutputId);
  });

  it("marks a job FAILED when no runner is registered for its job_type", async () => {
    // DETECT_CONFLICTS has no registered runner yet (Phase 4) -- MERGE itself
    // is now registered, so this must use a still-unregistered job_type.
    const job = await prisma.job.create({
      data: { workflowId, jobType: JobType.DETECT_CONFLICTS, status: JobStatus.QUEUED },
    });

    await processUntilSettled(job.id);

    const reloaded = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(reloaded.status).toBe(JobStatus.FAILED);
    expect(reloaded.error).toMatch(/No runner registered/);
  });

  it("retry lineage flows from a manually-enqueued retry job through to the resulting ai_outputs row", async () => {
    // Uses its own workflow rather than the shared one above, since this
    // exercises VALIDATE_TRANSCRIPT from a fresh VALIDATING_TRANSCRIPT state.
    const retryUser = await prisma.user.create({
      data: { name: "Retry Lineage User", email: `retry-lineage-${randomUUID()}@example.com`, role: "reviewer" },
    });
    const workflow = await engine.createWorkflow({ title: "Retry Lineage Workflow", createdById: retryUser.id });
    await engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "upload_transcript" },
      actor: { actorType: ActorType.USER, actorId: retryUser.id },
    });
    await engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "submit_for_validation" },
      actor: { actorType: ActorType.USER, actorId: retryUser.id },
    });
    const transcript = await createTranscriptVersion({
      workflowId: workflow.id,
      uploadedById: retryUser.id,
      content: "the first attempt's transcript content",
    });

    // TranscriptQualityChecker's stub always reports confidence 0.9 for
    // non-empty content (fixed, per Phase 2) -- temporarily raise the
    // threshold above that so the first run opens a real checkpoint instead
    // of auto-approving, mirroring Phase 2's own manual-verification
    // workaround for this same fixed-value stub. This also means the retried
    // attempt (still 0.9, still below 0.95) reopens a checkpoint rather than
    // reaching MERGING, so this test never touches the Merger/job-queue
    // interaction that gateway.test.ts and the MERGE-job tests above already cover.
    await prisma.approvalPolicy.update({ where: { skillName: SKILL_NAME }, data: { confidenceThreshold: 0.95 } });
    try {
      const firstJob = await enqueue({
        workflowId: workflow.id,
        jobType: JobType.VALIDATE_TRANSCRIPT,
        inputRef: transcript.id,
      });
      await processUntilSettled(firstJob.id);
      const completedFirstJob = await prisma.job.findUniqueOrThrow({ where: { id: firstJob.id } });
      expect(completedFirstJob.status).toBe(JobStatus.SUCCEEDED);
      const firstOutput = await prisma.aiOutput.findUniqueOrThrow({
        where: { id: completedFirstJob.resultAiOutputId! },
      });
      expect(firstOutput.attemptNumber).toBe(1);

      const afterFirst = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
      expect(afterFirst.currentState).toBe(WorkflowState.PENDING_HUMAN_CONFIRMATION);

      // The real retry path: routes back through VALIDATING_TRANSCRIPT and
      // enqueues the retry job itself (approval/gateway.ts's enqueueForStateEntry) --
      // this test only asserts what processNextJob() does with that job.
      const retried = await retryApprovalRequest({ workflowId: workflow.id, actorId: retryUser.id });
      expect(retried.currentState).toBe(WorkflowState.VALIDATING_TRANSCRIPT);

      const retryJob = await prisma.job.findFirstOrThrow({
        where: { workflowId: workflow.id, jobType: JobType.VALIDATE_TRANSCRIPT, retryOfAiOutputId: firstOutput.id },
      });
      await processUntilSettled(retryJob.id);

      const completedRetryJob = await prisma.job.findUniqueOrThrow({ where: { id: retryJob.id } });
      expect(completedRetryJob.status).toBe(JobStatus.SUCCEEDED);
      const retryOutput = await prisma.aiOutput.findUniqueOrThrow({
        where: { id: completedRetryJob.resultAiOutputId! },
      });
      expect(retryOutput.attemptNumber).toBe(2);
      expect(retryOutput.retryOfAiOutputId).toBe(firstOutput.id);
      expect(retryOutput.retryMode).toBe("SAME_INPUT");
    } finally {
      await prisma.approvalPolicy.update({ where: { skillName: SKILL_NAME }, data: { confidenceThreshold: 0.75 } });
    }

    // Cleanup for this test's own dedicated workflow/user.
    await prisma.stateTransition.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.approvalRequest.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.job.updateMany({
      where: { workflowId: workflow.id },
      data: { resultAiOutputId: null, retryOfAiOutputId: null },
    });
    await prisma.aiOutputInput.deleteMany({ where: { aiOutput: { workflowId: workflow.id } } });
    await prisma.merge.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.aiOutput.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.job.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.transcript.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.workflow.delete({ where: { id: workflow.id } });
    await prisma.user.delete({ where: { id: retryUser.id } });
    rmSync(path.resolve(env.storageRootDir, workflow.id), { recursive: true, force: true });
  });
});
