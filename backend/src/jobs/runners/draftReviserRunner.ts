import type { Prisma } from "@prisma/client";
import * as draftReviser from "../../ai/skills/draftReviser";
import type { DraftSection } from "../../ai/skillEnvelope";
import { handleSkillOutput } from "../../approval/gateway";
import { validateDraftStructure } from "../../approval/reportStructureValidator";
import { createDraftVersion, findLatestDraft } from "../../persistence/repositories/draftRepository";
import { findLatestMerge } from "../../persistence/repositories/mergeRepository";
import { findFeedbackForDraft } from "../../persistence/repositories/reviewFeedbackRepository";
import { findPolicyByKey } from "../../persistence/repositories/reportTypePolicyRepository";
import type { JobRunnerInput, JobRunnerResult } from "../worker";

// REVISE_DRAFT jobs never carry an explicit inputRef -- like
// GENERATE_DRAFT/DRAFT_QUALITY_PRECHECK jobs, this runner always resolves the
// workflow's latest draft directly (the one that was just sent back for
// changes). DraftReviser declares inputs: [] in gateway.ts's SKILL_ROUTING
// (it reads drafted output + review_feedback, not a transcript/notes
// version), so no ai_output_inputs lineage is written here, matching that
// scope decision.
//
// Phase 16 item 4: a revision now regenerates the full document from the
// original source again -- transcript+notes (via the same `merges` output
// draftGenerationRunner.ts drafted from), the current draft, and the
// reviewer feedback -- rather than asking the model to patch the previous
// draft in isolation. Without the original source, the model has nothing to
// fall back on but the prior draft's own prose, which is exactly what made
// the Phase 8 stub (and a source-blind LLM call would too) unable to make
// real structural changes stick.
export async function runReviseDraftJob(job: JobRunnerInput): Promise<JobRunnerResult> {
  const previousDraft = await findLatestDraft(job.workflowId);
  if (!previousDraft) {
    throw new Error(`Workflow ${job.workflowId} has no draft to revise (job ${job.id})`);
  }

  const policy = await findPolicyByKey(previousDraft.reportType);
  if (!policy) {
    // Should not happen -- previousDraft.reportType is set from the same
    // catalog key draftGenerationRunner.ts (or a prior revision) resolved.
    throw new Error(`No report_type_policies row for key "${previousDraft.reportType}" (job ${job.id})`);
  }

  const merge = await findLatestMerge(job.workflowId);
  if (!merge) {
    throw new Error(`Workflow ${job.workflowId} has no merged output to revise from (job ${job.id})`);
  }
  const mergedSections = (merge.mergedSections as unknown as Array<{ content: string }>) ?? [];
  const mergedContent = mergedSections.map((section) => section.content).join("\n");

  const feedback = await findFeedbackForDraft(previousDraft.id);

  const envelope = await draftReviser.run({
    mergedContent,
    promptRef: policy.promptRef,
    subject: previousDraft.subject,
    previousSections: previousDraft.sections as unknown as DraftSection[],
    feedbackItems: feedback.map((entry) => entry.feedback),
  });

  const { aiOutputId } = await handleSkillOutput({
    workflowId: job.workflowId,
    jobId: job.id,
    envelope,
    promptVersion: draftReviser.PROMPT_VERSION,
    schemaVersion: draftReviser.SCHEMA_VERSION,
    retryOfAiOutputId: job.retryOfAiOutputId ?? undefined,
    retryMode: job.retryMode ?? undefined,
    // Phase 16 item 5: relaxed -- a reviewer's feedback may deliberately
    // deviate from the report type's standard sections (drop them,
    // restructure them), and that deliberate choice must not be rejected by
    // the same gate that enforces the standard format on first generation.
    // Basic header facts (title/attendees/date/subject) stay mandatory.
    additionalValidation: () =>
      validateDraftStructure(
        {
          title: previousDraft.title,
          attendees: previousDraft.attendees,
          date: previousDraft.date,
          subject: previousDraft.subject,
          sections: envelope.result.sections,
        },
        policy,
        { skipContentSections: true },
      ),
  });

  // A new version, not an update -- Draft stays insert-only. Header metadata
  // (title/attendees/date/subject/reportType) carries over unchanged from the
  // draft being revised; only sections/coverage reflect the revision.
  await createDraftVersion({
    workflowId: job.workflowId,
    aiOutputId,
    reportType: previousDraft.reportType,
    title: previousDraft.title,
    attendees: previousDraft.attendees as unknown as Prisma.InputJsonValue,
    date: previousDraft.date,
    subject: previousDraft.subject,
    sections: envelope.result.sections as unknown as Prisma.InputJsonValue,
    coverage: previousDraft.coverage ?? undefined,
    actionsPresent: envelope.result.actions_present,
  });

  return { resultAiOutputId: aiOutputId };
}
