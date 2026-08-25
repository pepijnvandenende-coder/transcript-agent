import { type Prisma, PostProcessingResultStatus, ValidationStatus } from "@prisma/client";
import type { PostProcessingEnvelope, PostProcessingExecution, SkillEnvelope } from "../../ai/skillEnvelope";
import * as criteriaCoverageAnalyzer from "../../ai/skills/criteriaCoverageAnalyzer";
import * as finalRenderer from "../../ai/skills/finalRenderer";
import * as openQuestionsAnalyzer from "../../ai/skills/openQuestionsAnalyzer";
import { handleSkillOutput } from "../../approval/gateway";
import { checkSchema } from "../../approval/schemaValidator";
import { findLatestContextItem } from "../../persistence/repositories/contextItemRepository";
import { createAiOutput, markAiOutputAutoApproved } from "../../persistence/repositories/aiOutputRepository";
import { findLatestDraft } from "../../persistence/repositories/draftRepository";
import { createPostProcessingResult } from "../../persistence/repositories/postProcessingResultRepository";
import { findActivePostProcessingSkillPolicies } from "../../persistence/repositories/postProcessingSkillPolicyRepository";
import { localFilesystemStorage } from "../../storage/localFilesystemStorage";
import type { JobRunnerInput, JobRunnerResult } from "../worker";

// Phase 18: the ONE mapping point a new follow-up skill needs in code -- the
// catalog (post_processing_skill_policies) drives WHICH skills run and in
// what order; this map drives WHAT running a given key actually does. Adding
// a third skill is one entry here plus one skill module, no FSM/state change.
type PostProcessingSkillRunner = (ctx: { reportContent: string; contextContent?: string }) => Promise<SkillEnvelope>;

const SKILL_MODULES: Record<string, PostProcessingSkillRunner> = {
  open_questions: (ctx) => openQuestionsAnalyzer.run({ reportContent: ctx.reportContent }),
  norm_coverage: (ctx) =>
    criteriaCoverageAnalyzer.run({ reportContent: ctx.reportContent, criteriaContent: ctx.contextContent ?? "" }),
};

// RUN_POST_PROCESSING is the single job for the POST_PROCESSING state (see
// approval/gateway.ts's SKILL_ROUTING["PostProcessing"] entry). Unlike every
// earlier runner, this one fans out into N sub-skills (whichever
// post_processing_skill_policies rows are active) instead of driving exactly
// one ai_outputs row/FSM transition -- each sub-skill gets its own
// ai_outputs governance row (when it actually runs) and its own
// post_processing_results row; a failing or skipped sub-skill never aborts
// the others or the job itself, so one bad follow-up skill can't strand the
// workflow before COMPLETED.
export async function runPostProcessingJob(job: JobRunnerInput): Promise<JobRunnerResult> {
  const draft = await findLatestDraft(job.workflowId);
  if (!draft) {
    throw new Error(`Workflow ${job.workflowId} has no approved draft to run post-processing on (job ${job.id})`);
  }
  const reportContent = finalRenderer.renderContent({
    title: draft.title,
    attendees: draft.attendees as unknown as string[],
    date: draft.date,
    subject: draft.subject,
    sections: draft.sections as unknown as Array<{ heading: string; content: string }>,
  });

  const activePolicies = await findActivePostProcessingSkillPolicies();
  const executed: PostProcessingExecution[] = [];

  for (const policy of activePolicies) {
    const runner = SKILL_MODULES[policy.key];
    if (!runner) {
      // A catalog row with no matching code-level skill yet -- skipped, not
      // a hard failure, so the catalog and the code can be extended
      // independently without breaking the phase.
      await createPostProcessingResult({
        workflowId: job.workflowId,
        skillKey: policy.key,
        status: PostProcessingResultStatus.SKIPPED,
        errorMessage: `Geen skill-implementatie geregistreerd voor "${policy.key}".`,
      });
      executed.push({ skill_key: policy.key, status: "skipped" });
      continue;
    }

    let contextContent: string | undefined;
    if (policy.requiresContextType) {
      const contextItem = await findLatestContextItem(job.workflowId, policy.requiresContextType);
      if (!contextItem) {
        await createPostProcessingResult({
          workflowId: job.workflowId,
          skillKey: policy.key,
          status: PostProcessingResultStatus.SKIPPED,
          errorMessage: `Geen "${policy.requiresContextType}" context aangeleverd voor deze workflow.`,
        });
        executed.push({ skill_key: policy.key, status: "skipped" });
        continue;
      }
      contextContent = await localFilesystemStorage.get(contextItem.storageRef);
    }

    try {
      const envelope = await runner({ reportContent, contextContent });
      const schemaCheck = checkSchema(envelope.skill, envelope);
      if (!schemaCheck.valid) {
        await createPostProcessingResult({
          workflowId: job.workflowId,
          skillKey: policy.key,
          status: PostProcessingResultStatus.FAILED,
          errorMessage: `Ongeldige AI-output: ${JSON.stringify(schemaCheck.errors)}`,
        });
        executed.push({ skill_key: policy.key, status: "failed" });
        continue;
      }

      const aiOutput = await createAiOutput({
        jobId: job.id,
        workflowId: job.workflowId,
        skillName: envelope.skill,
        promptVersion: "llm-1",
        schemaVersion: envelope.schema_version,
        rawOutput: envelope as unknown as Prisma.InputJsonValue,
        validationStatus: ValidationStatus.VALID,
        confidenceScore: envelope.confidence,
      });
      await markAiOutputAutoApproved(aiOutput.id);

      await createPostProcessingResult({
        workflowId: job.workflowId,
        skillKey: policy.key,
        status: PostProcessingResultStatus.COMPLETED,
        aiOutputId: aiOutput.id,
        resultJson: envelope.result as unknown as Prisma.InputJsonValue,
      });
      executed.push({ skill_key: policy.key, status: "completed" });
    } catch (err) {
      await createPostProcessingResult({
        workflowId: job.workflowId,
        skillKey: policy.key,
        status: PostProcessingResultStatus.FAILED,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      executed.push({ skill_key: policy.key, status: "failed" });
    }
  }

  const orchestratorEnvelope: PostProcessingEnvelope = {
    skill: "PostProcessing",
    schema_version: "1.0.0",
    confidence: 1,
    rationale: `Postprocessing uitgevoerd voor ${activePolicies.length} actieve vervolgstap(pen).`,
    flags: [],
    result: { executed },
  };

  const { aiOutputId } = await handleSkillOutput({
    workflowId: job.workflowId,
    jobId: job.id,
    envelope: orchestratorEnvelope,
    promptVersion: "orchestrator-1",
    schemaVersion: "1.0.0",
  });

  return { resultAiOutputId: aiOutputId };
}
