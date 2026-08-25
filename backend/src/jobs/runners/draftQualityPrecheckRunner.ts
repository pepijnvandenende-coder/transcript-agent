import type { Prisma } from "@prisma/client";
import * as draftQualityPrecheck from "../../ai/skills/draftQualityPrecheck";
import { handleSkillOutput } from "../../approval/gateway";
import { asStringArray, checkDraftStructure } from "../../approval/reportStructureValidator";
import { createDraftPrecheck } from "../../persistence/repositories/draftPrecheckRepository";
import { findLatestDraft } from "../../persistence/repositories/draftRepository";
import { findLatestMerge } from "../../persistence/repositories/mergeRepository";
import { findPolicyByKey } from "../../persistence/repositories/reportTypePolicyRepository";
import type { DraftSection } from "../../ai/skillEnvelope";
import type { JobRunnerInput, JobRunnerResult } from "../worker";

// DRAFT_QUALITY_PRECHECK jobs never carry an explicit inputRef -- like
// DETECT_CONFLICTS/SUGGEST_REPORT_TYPE/GENERATE_DRAFT jobs, this runner
// always resolves the workflow's latest draft directly. DraftQualityPrecheck
// declares inputs: [] in gateway.ts's SKILL_ROUTING (it reads drafted output,
// not a transcript/notes version), so no ai_output_inputs lineage is written
// here, matching that scope decision.
export async function runDraftQualityPrecheckJob(job: JobRunnerInput): Promise<JobRunnerResult> {
  const draft = await findLatestDraft(job.workflowId);
  if (!draft) {
    throw new Error(`Workflow ${job.workflowId} has no draft to precheck (job ${job.id})`);
  }

  const policy = await findPolicyByKey(draft.reportType);
  if (!policy) {
    // Should not happen -- draft.reportType is set from the same catalog key
    // draftGenerationRunner.ts resolved when it created this draft.
    throw new Error(`No report_type_policies row for key "${draft.reportType}" (job ${job.id})`);
  }

  const merge = await findLatestMerge(job.workflowId);
  if (!merge) {
    throw new Error(`Workflow ${job.workflowId} has no merged output to check the draft against (job ${job.id})`);
  }
  const mergedSections = (merge.mergedSections as unknown as Array<{ content: string }>) ?? [];
  const sourceText = mergedSections.map((section) => section.content).join("\n");

  const sections = draft.sections as unknown as DraftSection[];
  const attendees = draft.attendees as unknown as string[];
  const structuralItems = checkDraftStructure(
    { title: draft.title, attendees, date: draft.date, subject: draft.subject, sections },
    policy,
  );

  const envelope = await draftQualityPrecheck.run({
    title: draft.title,
    attendees,
    date: draft.date,
    subject: draft.subject,
    sections,
    sourceText,
    structuralItems,
    optionalSections: asStringArray(policy.optionalSections),
    actionsPresentInSource: draft.actionsPresent,
  });

  const { aiOutputId } = await handleSkillOutput({
    workflowId: job.workflowId,
    jobId: job.id,
    envelope,
    promptVersion: draftQualityPrecheck.PROMPT_VERSION,
    schemaVersion: draftQualityPrecheck.SCHEMA_VERSION,
    retryOfAiOutputId: job.retryOfAiOutputId ?? undefined,
    retryMode: job.retryMode ?? undefined,
  });

  // Written regardless of the eventual approval outcome, mirroring how
  // ai_outputs preserves every attempt -- see prisma/schema.prisma's
  // DraftPrecheck model.
  await createDraftPrecheck({
    workflowId: job.workflowId,
    draftId: draft.id,
    aiOutputId,
    overallScore: envelope.result.overall_score,
    checklist: envelope.result.checklist as unknown as Prisma.InputJsonValue,
    blockingIssues: envelope.result.blocking_issues as unknown as Prisma.InputJsonValue,
    recommendation: envelope.result.recommendation,
  });

  return { resultAiOutputId: aiOutputId };
}
