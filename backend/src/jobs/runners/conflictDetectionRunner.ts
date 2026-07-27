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

  const mergedSections = (merge.mergedSections as unknown as Array<{ source: string }>) ?? [];
  const hasNotesSection = mergedSections.some((section) => section.source === "notes" || section.source === "both");
  const unmatchedNotes = (merge.unmatchedNotes as unknown as string[]) ?? [];

  // Phase 13: a transcript-only merge has a single source -- there is
  // structurally nothing to compare for conflicts, so calling the skill
  // would only ever produce a vacuous "no conflicts" result at real cost
  // (once ConflictDetector, like DraftGenerator/ReportTypeAdvisor, becomes a
  // real LLM call). Skip the call entirely rather than invoke it for a
  // foregone conclusion; the resulting envelope is otherwise identical to
  // what the stub already always returns for this case.
  const envelope = hasNotesSection
    ? conflictDetector.run(unmatchedNotes)
    : {
        skill: conflictDetector.SKILL_NAME,
        schema_version: conflictDetector.SCHEMA_VERSION,
        confidence: 1,
        rationale: "Skipped: single-source merge (no notes) has nothing to compare for conflicts.",
        flags: ["no_notes_to_compare"],
        result: { conflicts: [] },
      };

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
