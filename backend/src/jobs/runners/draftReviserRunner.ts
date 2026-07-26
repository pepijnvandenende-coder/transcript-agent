import type { Prisma } from "@prisma/client";
import * as draftReviser from "../../ai/skills/draftReviser";
import type { DraftSection } from "../../ai/skillEnvelope";
import { handleSkillOutput } from "../../approval/gateway";
import { validateRequiredSections } from "../../approval/reportStructureValidator";
import { createDraftVersion, findLatestDraft } from "../../persistence/repositories/draftRepository";
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

  const feedback = await findFeedbackForDraft(previousDraft.id);

  const envelope = draftReviser.run({
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
    additionalValidation: () => validateRequiredSections(envelope.result.sections, policy),
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
  });

  return { resultAiOutputId: aiOutputId };
}
