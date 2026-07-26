import type { TransitionTrigger } from "../domain/types";
import type { WorkflowState } from "./states";
import { TRANSITIONS, type TransitionRule } from "./transitions";

function triggersMatch(a: TransitionTrigger, b: TransitionTrigger): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "user_action" && b.kind === "user_action") return a.action === b.action;
  if (a.kind === "system_event" && b.kind === "system_event") return a.event === b.event;
  return false;
}

/**
 * Looks up the single rule (if any) matching the given (state, trigger) pair.
 * This is the ONLY function allowed to decide whether a transition is legal.
 * engine.ts must always go through this rather than inspecting TRANSITIONS
 * itself, so there is exactly one place in the codebase that can approve a
 * move from one state to another.
 */
export function findMatchingRule(from: WorkflowState, trigger: TransitionTrigger): TransitionRule | undefined {
  return TRANSITIONS.find((rule) => rule.from === from && triggersMatch(rule.trigger, trigger));
}

export function isValidTransition(from: WorkflowState, trigger: TransitionTrigger): boolean {
  return findMatchingRule(from, trigger) !== undefined;
}
