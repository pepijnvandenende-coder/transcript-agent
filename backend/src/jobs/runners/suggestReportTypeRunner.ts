import { handleSkillOutput } from "../../approval/gateway";
import * as reportTypeAdvisor from "../../ai/skills/reportTypeAdvisor";
import { findLatestMerge } from "../../persistence/repositories/mergeRepository";
import { findPolicyByKey } from "../../persistence/repositories/reportTypePolicyRepository";
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

  // Phase 6 retrofit: the skill itself stays DB-free (pure function) -- this
  // runner fetches the catalog's own Dutch display names and passes them in,
  // so the suggestion is always catalog-backed even if the catalog's wording
  // changes later.
  const [thematicPolicy, qaPolicy] = await Promise.all([findPolicyByKey("thematic"), findPolicyByKey("qa")]);
  const envelope = reportTypeAdvisor.run(mergedContent, {
    thematicLabel: thematicPolicy?.displayName ?? "thematic",
    qaLabel: qaPolicy?.displayName ?? "qa",
  });

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
