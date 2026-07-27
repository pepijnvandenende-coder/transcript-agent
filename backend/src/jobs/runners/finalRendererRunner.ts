import * as finalRenderer from "../../ai/skills/finalRenderer";
import type { DraftSection } from "../../ai/skillEnvelope";
import { handleSkillOutput } from "../../approval/gateway";
import { createFinalReport } from "../../persistence/repositories/finalReportRepository";
import { findLatestDraft } from "../../persistence/repositories/draftRepository";
import { localFilesystemStorage } from "../../storage/localFilesystemStorage";
import type { JobRunnerInput, JobRunnerResult } from "../worker";

// RENDER_FINAL jobs never carry an explicit inputRef -- like every other
// PROCESSING state past the first, this runner always resolves the
// workflow's latest draft directly (the one approveDraft() just finalized).
// FinalRenderer declares inputs: [] in gateway.ts's SKILL_ROUTING (it reads
// drafted output, not a transcript/notes version), so no ai_output_inputs
// lineage is written here, matching every later-phase skill's scope decision.
export async function runRenderFinalJob(job: JobRunnerInput): Promise<JobRunnerResult> {
  const draft = await findLatestDraft(job.workflowId);
  if (!draft) {
    throw new Error(`Workflow ${job.workflowId} has no approved draft to render (job ${job.id})`);
  }

  const draftParams = {
    title: draft.title,
    attendees: draft.attendees as unknown as string[],
    date: draft.date,
    subject: draft.subject,
    sections: draft.sections as unknown as DraftSection[],
  };
  // Phase 15 item 4: .docx is the primary, downloadable final-report format
  // -- see docs/phase-15/README.md item 4. renderContent() (Markdown) stays
  // available on finalRenderer.ts but is no longer what's stored/downloaded.
  const docxBuffer = await finalRenderer.renderDocx(draftParams);
  const envelope = finalRenderer.run();

  const { aiOutputId } = await handleSkillOutput({
    workflowId: job.workflowId,
    jobId: job.id,
    envelope,
    promptVersion: finalRenderer.PROMPT_VERSION,
    schemaVersion: finalRenderer.SCHEMA_VERSION,
    retryOfAiOutputId: job.retryOfAiOutputId ?? undefined,
    retryMode: job.retryMode ?? undefined,
  });

  // COMPLETED is terminal with no re-entry edge, so there is only ever one
  // final report per workflow -- unlike Transcript/Draft's version-numbered
  // refs, this ref is fixed.
  const storageRef = `${job.workflowId}/final-reports/report.docx`;
  await localFilesystemStorage.putBinary(storageRef, docxBuffer);

  // Written regardless of the eventual approval outcome, mirroring how
  // ai_outputs preserves every attempt -- see prisma/schema.prisma's
  // FinalReport model.
  await createFinalReport({
    workflowId: job.workflowId,
    draftId: draft.id,
    aiOutputId,
    title: draft.title,
    format: "docx",
    storageRef,
  });

  return { resultAiOutputId: aiOutputId };
}
