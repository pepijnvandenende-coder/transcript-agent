import { ActorType, JobType, type RetryMode } from "@prisma/client";
import { originatingStateForJobType } from "../approval/gateway";
import { claimNextQueuedJob, markJobFailed, markJobSucceeded } from "../persistence/repositories/jobRepository";
import * as engine from "../workflow/engine";
import { runDetectConflictsJob } from "./runners/conflictDetectionRunner";
import { runDraftQualityPrecheckJob } from "./runners/draftQualityPrecheckRunner";
import { runGenerateDraftJob } from "./runners/draftGenerationRunner";
import { runReviseDraftJob } from "./runners/draftReviserRunner";
import { runRenderFinalJob } from "./runners/finalRendererRunner";
import { runMergeJob } from "./runners/mergeRunner";
import { runSuggestReportTypeJob } from "./runners/suggestReportTypeRunner";
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
  [JobType.DETECT_CONFLICTS]: runDetectConflictsJob,
  [JobType.SUGGEST_REPORT_TYPE]: runSuggestReportTypeJob,
  [JobType.GENERATE_DRAFT]: runGenerateDraftJob,
  [JobType.DRAFT_QUALITY_PRECHECK]: runDraftQualityPrecheckJob,
  [JobType.REVISE_DRAFT]: runReviseDraftJob,
  [JobType.RENDER_FINAL]: runRenderFinalJob,
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
    await failJob(job.id, job.workflowId, job.jobType, `No runner registered for job type ${job.jobType}`);
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
    await failJob(job.id, job.workflowId, job.jobType, err instanceof Error ? err.message : String(err));
  }
  return true;
}

// Phase 13 bug fix: markJobFailed() only ever updated the `jobs` row --
// nothing fired the `job_failed.<state>` system event that
// workflow/transitions.ts's FAILURE_TRANSITIONS already declares (since
// Phase 1), so a failed job left the workflow's own currentState stuck at
// whatever PROCESSING state it was in forever (e.g. GENERATING_DRAFT), with
// no visible error and no way to retry -- indistinguishable from "hanging"
// to an operator. This is the single choke point that actually raises that
// event, for both a thrown runner and a missing-runner misconfiguration.
async function failJob(jobId: string, workflowId: string, jobType: JobType, error: string): Promise<void> {
  await markJobFailed(jobId, error);

  const state = originatingStateForJobType(jobType);
  if (!state) {
    // Should not happen -- every registered JobType has a SKILL_ROUTING
    // entry with an originatingState. Surfaced via the job's own `error`
    // column (already written above) rather than thrown, so one
    // misconfigured job type can't crash the whole polling loop.
    console.error(`No originating WorkflowState registered for job type ${jobType}; cannot fail workflow ${workflowId}`);
    return;
  }

  try {
    await engine.transition({
      workflowId,
      trigger: { kind: "system_event", event: `job_failed.${state}` },
      actor: { actorType: ActorType.SYSTEM },
      metadata: { reason: "job_failed", jobId, error },
    });
  } catch (transitionErr) {
    // Never let a failure to *record* the failure crash the polling loop --
    // that would silently stop every future job across every workflow,
    // reintroducing the exact "stuck forever" symptom this fix exists to
    // close. The job row already carries `error` regardless.
    console.error(`Failed to transition workflow ${workflowId} to FAILED after job ${jobId}:`, transitionErr);
  }
}

export async function runPollingLoop(intervalMs = 2000): Promise<never> {
  for (;;) {
    const didWork = await processNextJob();
    await new Promise((resolve) => setTimeout(resolve, didWork ? 0 : intervalMs));
  }
}
