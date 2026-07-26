import { AiOutputInputType, type Prisma } from "@prisma/client";
import { handleSkillOutput } from "../../approval/gateway";
import * as merger from "../../ai/skills/merger";
import { createMergeVersion } from "../../persistence/repositories/mergeRepository";
import { findLatestNote } from "../../persistence/repositories/noteRepository";
import { findLatestTranscript } from "../../persistence/repositories/transcriptRepository";
import { localFilesystemStorage } from "../../storage/localFilesystemStorage";
import type { JobRunnerInput, JobRunnerResult } from "../worker";

// MERGE jobs never carry an explicit inputRef -- unlike VALIDATE_TRANSCRIPT's
// single input, Merger consumes two (transcript + optional notes), so this
// runner always resolves the latest version of each directly. ai_output_inputs
// (below) is the authoritative record of which versions were actually
// consumed, superseding the need for a single inputRef column.
export async function runMergeJob(job: JobRunnerInput): Promise<JobRunnerResult> {
  const transcript = await findLatestTranscript(job.workflowId);
  if (!transcript) {
    throw new Error(`Workflow ${job.workflowId} has no transcript to merge (job ${job.id})`);
  }
  const transcriptContent = await localFilesystemStorage.get(transcript.storageRef);

  const note = await findLatestNote(job.workflowId);
  const notesContent = note ? await localFilesystemStorage.get(note.storageRef) : undefined;

  const envelope = merger.run(transcriptContent, notesContent);

  const inputs: Array<{ inputType: AiOutputInputType; inputId: string; inputVersion: number }> = [
    { inputType: AiOutputInputType.TRANSCRIPT, inputId: transcript.id, inputVersion: transcript.version },
  ];
  if (note) {
    inputs.push({ inputType: AiOutputInputType.NOTES, inputId: note.id, inputVersion: note.version });
  }

  const { aiOutputId } = await handleSkillOutput({
    workflowId: job.workflowId,
    jobId: job.id,
    envelope,
    promptVersion: merger.PROMPT_VERSION,
    schemaVersion: merger.SCHEMA_VERSION,
    retryOfAiOutputId: job.retryOfAiOutputId ?? undefined,
    retryMode: job.retryMode ?? undefined,
    inputs,
  });

  // Written regardless of the eventual approval outcome, mirroring how
  // ai_outputs preserves every attempt -- see prisma/schema.prisma's Merge model.
  await createMergeVersion({
    workflowId: job.workflowId,
    aiOutputId,
    mergedSections: envelope.result.merged_sections as unknown as Prisma.InputJsonValue,
    unmatchedNotes: envelope.result.unmatched_notes as unknown as Prisma.InputJsonValue,
  });

  return { resultAiOutputId: aiOutputId };
}
