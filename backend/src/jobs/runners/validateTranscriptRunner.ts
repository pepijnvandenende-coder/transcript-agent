import { handleSkillOutput } from "../../approval/gateway";
import * as transcriptQualityChecker from "../../ai/skills/transcriptQualityChecker";
import { findLatestTranscript, findTranscriptById } from "../../persistence/repositories/transcriptRepository";
import { localFilesystemStorage } from "../../storage/localFilesystemStorage";
import type { JobRunnerInput, JobRunnerResult } from "../worker";

// Jobs enqueued explicitly (validation.routes.ts) always set inputRef to a
// specific transcript id. Jobs enqueued by a Phase 3 retry/edit-retry at
// PENDING_HUMAN_CONFIRMATION (approval/gateway.ts's enqueueForStateEntry)
// never do -- that helper is skill-agnostic -- so this runner falls back to
// the workflow's latest transcript version in that case.
export async function runValidateTranscriptJob(job: JobRunnerInput): Promise<JobRunnerResult> {
  const transcript = job.inputRef ? await findTranscriptById(job.inputRef) : await findLatestTranscript(job.workflowId);
  if (!transcript) {
    throw new Error(`No transcript found for job ${job.id} (VALIDATE_TRANSCRIPT, workflow ${job.workflowId})`);
  }

  const content = await localFilesystemStorage.get(transcript.storageRef);
  const envelope = transcriptQualityChecker.run(content);

  const { aiOutputId } = await handleSkillOutput({
    workflowId: job.workflowId,
    jobId: job.id,
    envelope,
    promptVersion: transcriptQualityChecker.PROMPT_VERSION,
    schemaVersion: transcriptQualityChecker.SCHEMA_VERSION,
    retryOfAiOutputId: job.retryOfAiOutputId ?? undefined,
    retryMode: job.retryMode ?? undefined,
  });

  return { resultAiOutputId: aiOutputId };
}
