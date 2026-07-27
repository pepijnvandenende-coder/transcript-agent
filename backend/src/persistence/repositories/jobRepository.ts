import { JobStatus, type JobType, type RetryMode } from "@prisma/client";
import { prisma } from "../prismaClient";

export function createQueuedJob(params: {
  workflowId: string;
  jobType: JobType;
  inputRef?: string;
  retryOfAiOutputId?: string;
  retryMode?: RetryMode;
}) {
  return prisma.job.create({
    data: {
      workflowId: params.workflowId,
      jobType: params.jobType,
      inputRef: params.inputRef,
      retryOfAiOutputId: params.retryOfAiOutputId,
      retryMode: params.retryMode,
      status: JobStatus.QUEUED,
    },
  });
}

// Claims the oldest QUEUED job by flipping it to RUNNING conditioned on it
// still being QUEUED, so two concurrent callers can't both claim the same
// row. Phase 2 runs a single in-process worker (no daemon required -- see
// jobs/worker.ts), but this keeps the claim safe if that ever changes.
export async function claimNextQueuedJob() {
  const candidate = await prisma.job.findFirst({
    where: { status: JobStatus.QUEUED },
    orderBy: { createdAt: "asc" },
  });
  if (!candidate) return null;

  const claimed = await prisma.job.updateMany({
    where: { id: candidate.id, status: JobStatus.QUEUED },
    data: { status: JobStatus.RUNNING, attemptCount: { increment: 1 } },
  });
  if (claimed.count === 0) return null;

  return prisma.job.findUniqueOrThrow({ where: { id: candidate.id } });
}

// Phase 13: backs GET /workflows/:id/jobs/latest -- lets the frontend show
// *why* a workflow is waiting (queued vs. running) instead of a bare "busy"
// spinner, and surface the job's own `error` once it's failed.
export function findLatestJobForWorkflow(workflowId: string) {
  return prisma.job.findFirst({
    where: { workflowId },
    orderBy: { createdAt: "desc" },
  });
}

// Phase 13: backs POST /workflows/:id/actions/retry-failed-job -- the FAILED
// state's own most recent failure, specifically (not just "the latest job"),
// so a retry always targets the job that actually caused FAILED even if an
// older, already-resolved job row happens to be more recent by some other
// ordering.
export function findLatestFailedJobForWorkflow(workflowId: string) {
  return prisma.job.findFirst({
    where: { workflowId, status: JobStatus.FAILED },
    orderBy: { createdAt: "desc" },
  });
}

export function markJobSucceeded(jobId: string, params: { resultAiOutputId: string; outputRef?: string }) {
  return prisma.job.update({
    where: { id: jobId },
    data: {
      status: JobStatus.SUCCEEDED,
      resultAiOutputId: params.resultAiOutputId,
      outputRef: params.outputRef,
      completedAt: new Date(),
    },
  });
}

export function markJobFailed(jobId: string, error: string) {
  return prisma.job.update({
    where: { id: jobId },
    data: { status: JobStatus.FAILED, error, completedAt: new Date() },
  });
}
