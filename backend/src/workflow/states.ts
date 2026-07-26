import { WorkflowState } from "@prisma/client";

/**
 * WorkflowState is the single source of truth for the FSM's state space. It
 * is defined once, in prisma/schema.prisma, as a native Postgres enum; Prisma
 * generates the matching TypeScript enum, which is re-exported here rather
 * than redeclared, so the database schema and the engine can never drift out
 * of sync with each other.
 */
export { WorkflowState };

export const TERMINAL_STATES: ReadonlySet<WorkflowState> = new Set([
  WorkflowState.COMPLETED,
  WorkflowState.CANCELLED,
  WorkflowState.FAILED,
]);

export const ALL_STATES: readonly WorkflowState[] = Object.values(WorkflowState);

export function isTerminalState(state: WorkflowState): boolean {
  return TERMINAL_STATES.has(state);
}
