import type { Prisma } from "@prisma/client";
import { handleSkillOutput } from "../../approval/gateway";
import { validateRequiredSections } from "../../approval/reportStructureValidator";
import * as draftGenerator from "../../ai/skills/draftGenerator";
import { createDraftVersion } from "../../persistence/repositories/draftRepository";
import { findLatestMerge } from "../../persistence/repositories/mergeRepository";
import { findPolicyByKey } from "../../persistence/repositories/reportTypePolicyRepository";
import { findWorkflowById } from "../../persistence/repositories/workflowRepository";
import type { JobRunnerInput, JobRunnerResult } from "../worker";

// GENERATE_DRAFT jobs never carry an explicit inputRef -- like
// DETECT_CONFLICTS/SUGGEST_REPORT_TYPE jobs, this runner always resolves the
// workflow's latest merges row directly. DraftGenerator declares inputs: []
// in gateway.ts's SKILL_ROUTING (it reads merged output, not a
// transcript/notes version), so no ai_output_inputs lineage is written here,
// matching that scope decision.
export async function runGenerateDraftJob(job: JobRunnerInput): Promise<JobRunnerResult> {
  const workflow = await findWorkflowById(job.workflowId);
  if (!workflow) {
    throw new Error(`Workflow ${job.workflowId} not found (job ${job.id})`);
  }
  if (!workflow.reportType) {
    throw new Error(`Workflow ${job.workflowId} has no reportType selected yet (job ${job.id})`);
  }

  const policy = await findPolicyByKey(workflow.reportType);
  if (!policy) {
    // Should not happen once report-type selection is validated against the
    // catalog (Phase 6), but defended against here since workflows.reportType
    // has no DB-level foreign key to report_type_policies.
    throw new Error(`No report_type_policies row for key "${workflow.reportType}" (job ${job.id})`);
  }

  const merge = await findLatestMerge(job.workflowId);
  if (!merge) {
    throw new Error(`Workflow ${job.workflowId} has no merged output to draft from (job ${job.id})`);
  }

  const sections = (merge.mergedSections as unknown as Array<{ content: string }>) ?? [];
  const mergedContent = sections.map((section) => section.content).join("\n");

  const envelope = draftGenerator.run({
    mergedContent,
    policyKey: policy.key,
    subject: workflow.title,
    date: workflow.createdAt.toISOString().slice(0, 10),
  });

  const { aiOutputId } = await handleSkillOutput({
    workflowId: job.workflowId,
    jobId: job.id,
    envelope,
    promptVersion: draftGenerator.PROMPT_VERSION,
    schemaVersion: draftGenerator.SCHEMA_VERSION,
    retryOfAiOutputId: job.retryOfAiOutputId ?? undefined,
    retryMode: job.retryMode ?? undefined,
    additionalValidation: () => validateRequiredSections(envelope.result.sections, policy),
  });

  // Written regardless of the eventual approval outcome, mirroring how
  // ai_outputs preserves every attempt -- see prisma/schema.prisma's Draft model.
  await createDraftVersion({
    workflowId: job.workflowId,
    aiOutputId,
    reportType: envelope.result.report_type,
    title: envelope.result.title,
    attendees: envelope.result.attendees as unknown as Prisma.InputJsonValue,
    date: envelope.result.date,
    subject: envelope.result.subject,
    sections: envelope.result.sections as unknown as Prisma.InputJsonValue,
    coverage: envelope.result.coverage,
  });

  return { resultAiOutputId: aiOutputId };
}
