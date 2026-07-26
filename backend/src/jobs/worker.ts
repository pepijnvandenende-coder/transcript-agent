import { JobType, type RetryMode } from "@prisma/client";
import { claimNextQueuedJob, markJobFailed, markJobSucceeded } from "../persistence/repositories/jobRepository";
import { runMergeJob } from "./runners/mergeRunner";
import { runValidateTranscriptJob } from "./runners/validateTranscriptRunner";

export interface JobRunnerInput {
  id: string;
  workflowId: string;
  inputRef: string | null;
  retryOfAiOutputId: string | null;
  retryMode: RetryMode | null;
}

export interface JobRunnerResult {
  resultAiOutputId: string;
  outputRef?: string;
}

type JobRunner = (job: JobRunnerInput) => Promise<JobRunnerResult>;

const RUNNERS: Partial<Record<JobType, JobRunner>> = {
  [JobType.VALIDATE_TRANSCRIPT]: runValidateTranscriptJob,
  [JobType.MERGE]: runMergeJob,
};

/**
 * Claims and runs a single QUEUED job to completion. Returns whether a job
 * was found. Phase 2 locked decision: this is the function tests call
 * directly (no always-running daemon required) -- runPollingLoop below is
 * just a thin `npm run dev` convenience wrapper around it.
 */
export async function processNextJob(): Promise<boolean> {
  const job = await claimNextQueuedJob();
  if (!job) return false;

  const runner = RUNNERS[job.jobType];
  if (!runner) {
    await markJobFailed(job.id, `No runner registered for job type ${job.jobType}`);
    return true;
  }

  try {
    const result = await runner({
      id: job.id,
      workflowId: job.workflowId,
      inputRef: job.inputRef,
      retryOfAiOutputId: job.retryOfAiOutputId,
      retryMode: job.retryMode,
    });
    await markJobSucceeded(job.id, result);
  } catch (err) {
    await markJobFailed(job.id, err instanceof Error ? err.message : String(err));
  }
  return true;
}

export async function runPollingLoop(intervalMs = 2000): Promise<never> {
  for (;;) {
    const didWork = await processNextJob();
    await new Promise((resolve) => setTimeout(resolve, didWork ? 0 : intervalMs));
  }
}
