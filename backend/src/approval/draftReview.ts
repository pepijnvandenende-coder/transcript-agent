import { ActorType } from "@prisma/client";
import { DraftVersionMismatchError, NotAtDraftReviewError } from "../domain/types";
import { markAiOutputHumanApproved } from "../persistence/repositories/aiOutputRepository";
import { findLatestDraft } from "../persistence/repositories/draftRepository";
import { createReviewFeedback } from "../persistence/repositories/reviewFeedbackRepository";
import { findWorkflowById } from "../persistence/repositories/workflowRepository";
import * as engine from "../workflow/engine";
import { WorkflowState } from "../workflow/states";
import { enqueueForStateEntry } from "./gateway";

/**
 * DRAFT_PENDING_REVIEW's own two human actions (approve_draft,
 * request_draft_changes) live here rather than in gateway.ts -- like
 * conflictResolution.ts's CONFLICTS_PENDING_REVIEW actions, this is a
 * distinct sub-domain (acting on a specific draft version), not the generic
 * PENDING_HUMAN_CONFIRMATION checkpoint's confirm/retry/edit-retry. Both
 * still route through gateway.ts's enqueueForStateEntry() so landing on
 * GENERATING_FINAL/REVISING_DRAFT restarts the next skill's job the same way
 * every other PROCESSING-state entry does.
 */
async function loadDraftAtReview(workflowId: string, version: number) {
  const workflow = await findWorkflowById(workflowId);
  if (!workflow) {
    throw new Error(`Workflow ${workflowId} not found`);
  }
  if (workflow.currentState !== WorkflowState.DRAFT_PENDING_REVIEW) {
    throw new NotAtDraftReviewError(workflowId, workflow.currentState);
  }

  const latest = await findLatestDraft(workflowId);
  if (!latest || latest.version !== version) {
    throw new DraftVersionMismatchError(workflowId, version, latest?.version ?? null);
  }

  return { workflow, draft: latest };
}

/**
 * Approves the current latest draft: finalizes the DraftGenerator (or, once
 * Phase 8 exists, DraftReviser) ai_output that produced it, then advances to
 * GENERATING_FINAL.
 */
export async function approveDraft(params: {
  workflowId: string;
  actorId: string;
  version: number;
}): Promise<ReturnType<typeof engine.transition>> {
  const { draft } = await loadDraftAtReview(params.workflowId, params.version);

  await markAiOutputHumanApproved(draft.aiOutputId, params.actorId);

  const updated = await engine.transition({
    workflowId: params.workflowId,
    trigger: { kind: "user_action", action: "approve_draft" },
    actor: { actorType: ActorType.USER, actorId: params.actorId },
    metadata: { reason: "draft_approved", draftId: draft.id },
  });
  await enqueueForStateEntry(params.workflowId, updated.currentState);
  return updated;
}

/**
 * Sends the current latest draft back for changes: records the reviewer's
 * feedback (Phase 8's DraftReviser input), then advances to REVISING_DRAFT.
 * Unlike approveDraft, this does not finalize the draft's ai_output -- it's
 * being revised, not accepted.
 */
export async function requestDraftChanges(params: {
  workflowId: string;
  actorId: string;
  version: number;
  feedback: string;
}): Promise<ReturnType<typeof engine.transition>> {
  const { draft } = await loadDraftAtReview(params.workflowId, params.version);

  await createReviewFeedback({
    workflowId: params.workflowId,
    draftId: draft.id,
    feedback: params.feedback,
    createdById: params.actorId,
  });

  const updated = await engine.transition({
    workflowId: params.workflowId,
    trigger: { kind: "user_action", action: "request_draft_changes" },
    actor: { actorType: ActorType.USER, actorId: params.actorId },
    metadata: { reason: "draft_changes_requested", draftId: draft.id },
  });
  await enqueueForStateEntry(params.workflowId, updated.currentState);
  return updated;
}
