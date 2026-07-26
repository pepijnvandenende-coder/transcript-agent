import { handleSkillOutput } from "../../approval/gateway";
import * as conflictDetector from "../../ai/skills/conflictDetector";
import { createConflicts } from "../../persistence/repositories/conflictRepository";
import { findLatestMerge } from "../../persistence/repositories/mergeRepository";
import type { JobRunnerInput, JobRunnerResult } from "../worker";

// DETECT_CONFLICTS jobs never carry an explicit inputRef -- like MERGE jobs,
// this runner always resolves the workflow's latest merges row directly.
// ConflictDetector declares inputs: [] in gateway.ts's SKILL_ROUTING (it
// reads merged output, not a transcript/notes version), so no
// ai_output_inputs lineage is written here, matching that scope decision.
export async function runDetectConflictsJob(job: JobRunnerInput): Promise<JobRunnerResult> {
  const merge = await findLatestMerge(job.workflowId);
  if (!merge) {
    throw new Error(`Workflow ${job.workflowId} has no merged output to check for conflicts (job ${job.id})`);
  }

  const unmatchedNotes = (merge.unmatchedNotes as unknown as string[]) ?? [];
  const envelope = conflictDetector.run(unmatchedNotes);

  const { aiOutputId } = await handleSkillOutput({
    workflowId: job.workflowId,
    jobId: job.id,
    envelope,
    promptVersion: conflictDetector.PROMPT_VERSION,
    schemaVersion: conflictDetector.SCHEMA_VERSION,
    retryOfAiOutputId: job.retryOfAiOutputId ?? undefined,
    retryMode: job.retryMode ?? undefined,
  });

  // Only written when conflicts were actually found -- see
  // approval/policyResolver.ts's ConflictDetector semantic hook, which is
  // what routed this run to CONFLICTS_PENDING_REVIEW in the first place.
  if (envelope.result.conflicts.length > 0) {
    await createConflicts({
      workflowId: job.workflowId,
      aiOutputId,
      conflicts: envelope.result.conflicts.map((conflict) => ({
        description: conflict.description,
        sourceA: conflict.source_a,
        sourceB: conflict.source_b,
      })),
    });
  }

  return { resultAiOutputId: aiOutputId };
}
