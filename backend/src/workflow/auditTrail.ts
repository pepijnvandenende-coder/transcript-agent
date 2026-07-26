import type { ActorType, Prisma, WorkflowState } from "@prisma/client";

export interface AuditEntryInput {
  workflowId: string;
  fromState: WorkflowState | null;
  toState: WorkflowState;
  actorType: ActorType;
  actorId?: string | null;
  aiOutputId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * The single write path for state_transitions rows. Every FSM move --
 * workflow creation, a user action, or (in a later phase) a system event
 * raised by the Approval Gateway -- must go through this function, so the
 * audit trail can never be bypassed or partially written.
 */
export async function recordTransition(tx: Prisma.TransactionClient, entry: AuditEntryInput) {
  return tx.stateTransition.create({
    data: {
      workflowId: entry.workflowId,
      fromState: entry.fromState,
      toState: entry.toState,
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      aiOutputId: entry.aiOutputId ?? null,
      metadata: (entry.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}
