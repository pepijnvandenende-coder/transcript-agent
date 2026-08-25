import { ActorType, WorkflowState, WorkflowStatus } from "@prisma/client";
import { InvalidTransitionError, type TransitionRequest } from "../domain/types";
import { prisma } from "../persistence/prismaClient";
import { recordTransition } from "./auditTrail";
import { findMatchingRule } from "./guards";
import { TRANSITIONS } from "./transitions";

export async function createWorkflow(params: { title: string; createdById: string }) {
  return prisma.$transaction(async (tx) => {
    const workflow = await tx.workflow.create({
      data: {
        title: params.title,
        createdById: params.createdById,
        currentState: WorkflowState.CONTEXT_INPUT,
        status: WorkflowStatus.ACTIVE,
      },
    });

    // The creation event itself is recorded as the first audit row
    // (fromState null), so a workflow's history is complete from the moment
    // it exists.
    await recordTransition(tx, {
      workflowId: workflow.id,
      fromState: null,
      toState: WorkflowState.CONTEXT_INPUT,
      actorType: ActorType.USER,
      actorId: params.createdById,
      metadata: { reason: "workflow_created" },
    });

    return workflow;
  });
}

function statusForState(state: WorkflowState): WorkflowStatus | undefined {
  if (state === WorkflowState.COMPLETED) return WorkflowStatus.COMPLETED;
  if (state === WorkflowState.CANCELLED) return WorkflowStatus.CANCELLED;
  // FAILED is terminal but recoverable (retry_failed_job.* transitions back
  // out of it), so workflow.status intentionally stays ACTIVE.
  return undefined;
}

/**
 * Applies a single FSM transition. This is the ONLY function permitted to
 * change workflow.currentState. Callers (API routes today; the Approval
 * Gateway and job workers in later phases) describe intent via a
 * TransitionRequest; the engine decides purely by asking guards.ts to look
 * up the fixed table in transitions.ts. It never infers, guesses, or picks a
 * transition on its own -- if no rule matches, the transition is rejected
 * and nothing is written.
 */
export async function transition(request: TransitionRequest) {
  return prisma.$transaction(async (tx) => {
    const workflow = await tx.workflow.findUniqueOrThrow({
      where: { id: request.workflowId },
    });

    if (workflow.status !== WorkflowStatus.ACTIVE) {
      throw new Error(
        `Workflow ${request.workflowId} is not active (status: ${workflow.status}); no further transitions are allowed.`,
      );
    }

    const rule = findMatchingRule(workflow.currentState, request.trigger);
    if (!rule) {
      throw new InvalidTransitionError(request.workflowId, workflow.currentState, request.trigger);
    }

    const nextStatus = statusForState(rule.to);

    const updated = await tx.workflow.update({
      where: { id: request.workflowId },
      data: {
        currentState: rule.to,
        ...(nextStatus ? { status: nextStatus } : {}),
      },
    });

    await recordTransition(tx, {
      workflowId: request.workflowId,
      fromState: workflow.currentState,
      toState: rule.to,
      actorType: request.actor.actorType,
      actorId: request.actor.actorId,
      metadata: request.metadata,
    });

    return updated;
  });
}

/**
 * The user-triggerable actions valid from a given state -- used by
 * GET /workflows/:id/state. system_event triggers are deliberately excluded:
 * those are raised internally (by the Approval Gateway in a later phase),
 * never something an API caller does.
 */
export function getAllowedActions(state: WorkflowState): string[] {
  const actions: string[] = [];
  for (const rule of TRANSITIONS) {
    if (rule.from === state && rule.trigger.kind === "user_action") {
      actions.push(rule.trigger.action);
    }
  }
  return actions;
}
