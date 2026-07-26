import { ActorType, ConflictStatus } from "@prisma/client";
import { ConflictAlreadyResolvedError, ConflictNotFoundError, NotAtConflictReviewError } from "../domain/types";
import { markAiOutputHumanApproved } from "../persistence/repositories/aiOutputRepository";
import {
  findConflictById,
  findOpenConflicts,
  resolveConflict,
  supersedeOpenConflicts,
} from "../persistence/repositories/conflictRepository";
import { findWorkflowById } from "../persistence/repositories/workflowRepository";
import * as engine from "../workflow/engine";
import { WorkflowState } from "../workflow/states";
import { enqueueForStateEntry } from "./gateway";

/**
 * CONFLICTS_PENDING_REVIEW's own two human actions (explain_conflict,
 * restart_upload) live here rather than in gateway.ts -- they're a distinct
 * sub-domain (per-conflict bookkeeping, not the generic PENDING_HUMAN_CONFIRMATION
 * checkpoint's confirm/retry/edit-retry), but both still route through
 * gateway.ts's enqueueForStateEntry() so landing back on MERGING (via
 * explain_conflict) restarts the Merger job the same way every other
 * PROCESSING-state entry does.
 */
async function loadWorkflowAtConflictReview(workflowId: string) {
  const workflow = await findWorkflowById(workflowId);
  if (!workflow) {
    throw new Error(`Workflow ${workflowId} not found`);
  }
  if (workflow.currentState !== WorkflowState.CONFLICTS_PENDING_REVIEW) {
    throw new NotAtConflictReviewError(workflowId, workflow.currentState);
  }
  return workflow;
}

/**
 * Resolves one conflict. The workflow only advances (explain_conflict ->
 * MERGING) once every OPEN conflict for it has been explained -- enforced
 * here by re-counting open conflicts after resolving this one, per the
 * architecture's CHECKPOINT (mandatory) semantics for CONFLICTS_PENDING_REVIEW.
 * This business rule lives in application code, not the FSM, consistent with
 * the engine only ever checking a fixed transition table.
 */
export async function explainConflict(params: {
  workflowId: string;
  conflictId: string;
  actorId: string;
  explanation: string;
}): Promise<{ conflict: Awaited<ReturnType<typeof resolveConflict>>; workflow: Awaited<ReturnType<typeof engine.transition>> | null }> {
  await loadWorkflowAtConflictReview(params.workflowId);

  const conflict = await findConflictById(params.conflictId);
  if (!conflict || conflict.workflowId !== params.workflowId) {
    throw new ConflictNotFoundError(params.workflowId, params.conflictId);
  }
  if (conflict.status !== ConflictStatus.OPEN) {
    throw new ConflictAlreadyResolvedError(params.conflictId);
  }

  const resolved = await resolveConflict(params.conflictId, {
    resolution: params.explanation,
    resolvedById: params.actorId,
  });

  const stillOpen = await findOpenConflicts(params.workflowId);
  if (stillOpen.length > 0) {
    return { conflict: resolved, workflow: null };
  }

  // Every conflict tied to this ai_output's episode is now explained -- the
  // governance table's approval_status is finalized here (mirrors
  // confirmApprovalRequest marking an output HUMAN_APPROVED at the generic
  // checkpoint), reflecting the last reviewer to clear a conflict.
  await markAiOutputHumanApproved(resolved.aiOutputId, params.actorId);

  const updatedWorkflow = await engine.transition({
    workflowId: params.workflowId,
    trigger: { kind: "user_action", action: "explain_conflict" },
    actor: { actorType: ActorType.USER, actorId: params.actorId },
    metadata: { reason: "all_conflicts_explained", conflictId: params.conflictId },
  });
  await enqueueForStateEntry(params.workflowId, updatedWorkflow.currentState);

  return { conflict: resolved, workflow: updatedWorkflow };
}

/**
 * Abandons this merge/conflict-review attempt: marks any still-open
 * conflicts resolved (resolution "superseded_by_restart", never deleted --
 * see conflictRepository.ts) and rewinds the workflow to TRANSCRIPT_UPLOADED.
 */
export async function restartUpload(params: {
  workflowId: string;
  actorId: string;
}): Promise<ReturnType<typeof engine.transition>> {
  await loadWorkflowAtConflictReview(params.workflowId);
  await supersedeOpenConflicts(params.workflowId, params.actorId);

  const updated = await engine.transition({
    workflowId: params.workflowId,
    trigger: { kind: "user_action", action: "restart_upload" },
    actor: { actorType: ActorType.USER, actorId: params.actorId },
    metadata: { reason: "restart_upload" },
  });
  await enqueueForStateEntry(params.workflowId, updated.currentState);
  return updated;
}
