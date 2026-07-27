import { handleSkillOutput } from "../../approval/gateway";
import * as reportTypeAdvisor from "../../ai/skills/reportTypeAdvisor";
import { findLatestMerge } from "../../persistence/repositories/mergeRepository";
import { findActivePolicies } from "../../persistence/repositories/reportTypePolicyRepository";
import { createReportTypeSuggestion } from "../../persistence/repositories/reportTypeSuggestionRepository";
import type { JobRunnerInput, JobRunnerResult } from "../worker";

// SUGGEST_REPORT_TYPE jobs never carry an explicit inputRef -- like
// DETECT_CONFLICTS jobs, this runner always resolves the workflow's latest
// merges row directly. ReportTypeAdvisor declares inputs: [] in gateway.ts's
// SKILL_ROUTING (it reads merged output, not a transcript/notes version), so
// no ai_output_inputs lineage is written here, matching that scope decision.
export async function runSuggestReportTypeJob(job: JobRunnerInput): Promise<JobRunnerResult> {
  const merge = await findLatestMerge(job.workflowId);
  if (!merge) {
    throw new Error(`Workflow ${job.workflowId} has no merged output to suggest a report type from (job ${job.id})`);
  }

  const sections = (merge.mergedSections as unknown as Array<{ content: string }>) ?? [];
  const mergedContent = sections.map((section) => section.content).join("\n");

  // Phase 13: the skill itself stays DB-free -- this runner fetches the full
  // active catalog and passes it in, so a third report type is one more
  // report_type_policies row, with no code change here (the skill's
  // structured-output schema is built from whatever list it's given).
  const policies = await findActivePolicies();
  const envelope = await reportTypeAdvisor.run(mergedContent, { policies });

  const { aiOutputId } = await handleSkillOutput({
    workflowId: job.workflowId,
    jobId: job.id,
    envelope,
    promptVersion: reportTypeAdvisor.PROMPT_VERSION,
    schemaVersion: reportTypeAdvisor.SCHEMA_VERSION,
    retryOfAiOutputId: job.retryOfAiOutputId ?? undefined,
    retryMode: job.retryMode ?? undefined,
  });

  // Written regardless of the (moot, since ReportTypeAdvisor is MANDATORY-
  // unconditional) approval outcome, mirroring how ai_outputs preserves every
  // attempt -- see prisma/schema.prisma's ReportTypeSuggestion model.
  await createReportTypeSuggestion({
    workflowId: job.workflowId,
    aiOutputId,
    suggestedType: envelope.result.suggested_type,
    rationale: envelope.result.rationale,
    runnerUp: envelope.result.runner_up,
  });

  return { resultAiOutputId: aiOutputId };
}
