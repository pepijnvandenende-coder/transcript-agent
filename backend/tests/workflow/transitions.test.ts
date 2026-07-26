import { describe, expect, it } from "vitest";
import type { TransitionTrigger } from "../../src/domain/types";
import { findMatchingRule, isValidTransition } from "../../src/workflow/guards";
import { ALL_STATES, TERMINAL_STATES, WorkflowState } from "../../src/workflow/states";
import { TRANSITIONS } from "../../src/workflow/transitions";

function triggerKey(trigger: TransitionTrigger): string {
  return trigger.kind === "user_action" ? `user_action:${trigger.action}` : `system_event:${trigger.event}`;
}

describe("transition table integrity", () => {
  it("has no duplicate (from, trigger) pairs", () => {
    const seen = new Set<string>();
    for (const rule of TRANSITIONS) {
      const key = `${rule.from}::${triggerKey(rule.trigger)}`;
      expect(seen.has(key), `duplicate rule for ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it("gives every non-terminal state at least one outgoing transition", () => {
    for (const state of ALL_STATES) {
      if (TERMINAL_STATES.has(state)) continue;
      const hasOutgoing = TRANSITIONS.some((rule) => rule.from === state);
      expect(hasOutgoing, `state ${state} has no outgoing transitions`).toBe(true);
    }
  });

  it("allows cancel from every non-terminal state", () => {
    for (const state of ALL_STATES) {
      if (TERMINAL_STATES.has(state)) continue;
      expect(
        isValidTransition(state, { kind: "user_action", action: "cancel" }),
        `cancel is not valid from ${state}`,
      ).toBe(true);
    }
  });

  it("does not allow cancel from terminal states", () => {
    for (const state of TERMINAL_STATES) {
      expect(isValidTransition(state, { kind: "user_action", action: "cancel" })).toBe(false);
    }
  });

  it("has no outgoing edges at all from terminal states other than the generated ones", () => {
    // COMPLETED and CANCELLED must have zero outgoing edges. FAILED is the
    // one terminal state with outgoing edges (retry_failed_job.*), by design.
    for (const state of [WorkflowState.COMPLETED, WorkflowState.CANCELLED]) {
      const outgoing = TRANSITIONS.filter((rule) => rule.from === state);
      expect(outgoing, `${state} should have no outgoing transitions`).toHaveLength(0);
    }
  });
});

describe("guards.findMatchingRule", () => {
  it("resolves the correct target for a known valid transition", () => {
    const rule = findMatchingRule(WorkflowState.CREATED, {
      kind: "user_action",
      action: "upload_transcript",
    });
    expect(rule?.to).toBe(WorkflowState.TRANSCRIPT_UPLOADED);
  });

  it("returns undefined for an action that is not valid from the current state", () => {
    const rule = findMatchingRule(WorkflowState.CREATED, {
      kind: "user_action",
      action: "approve_draft",
    });
    expect(rule).toBeUndefined();
  });

  it("returns undefined for a system_event that has no rule from this state", () => {
    const rule = findMatchingRule(WorkflowState.CREATED, {
      kind: "system_event",
      event: "draft_generated",
    });
    expect(rule).toBeUndefined();
  });

  it("distinguishes the three PENDING_HUMAN_CONFIRMATION contexts on confirm", () => {
    expect(
      findMatchingRule(WorkflowState.PENDING_HUMAN_CONFIRMATION, {
        kind: "user_action",
        action: "confirm.merge",
      })?.to,
    ).toBe(WorkflowState.DETECTING_CONFLICTS);

    expect(
      findMatchingRule(WorkflowState.PENDING_HUMAN_CONFIRMATION, {
        kind: "user_action",
        action: "confirm.transcript_validation",
      })?.to,
    ).toBe(WorkflowState.MERGING);

    expect(
      findMatchingRule(WorkflowState.PENDING_HUMAN_CONFIRMATION, {
        kind: "user_action",
        action: "confirm.conflict_detection",
      })?.to,
    ).toBe(WorkflowState.SUGGESTING_REPORT_TYPE);
  });

  it("routes retry and edit_retry back to the originating processing state", () => {
    expect(
      findMatchingRule(WorkflowState.PENDING_HUMAN_CONFIRMATION, {
        kind: "user_action",
        action: "retry.merge",
      })?.to,
    ).toBe(WorkflowState.MERGING);

    expect(
      findMatchingRule(WorkflowState.PENDING_HUMAN_CONFIRMATION, {
        kind: "user_action",
        action: "edit_retry.merge",
      })?.to,
    ).toBe(WorkflowState.MERGING);
  });

  it("allows retrying a failed job back into the state that failed", () => {
    expect(
      findMatchingRule(WorkflowState.FAILED, {
        kind: "user_action",
        action: `retry_failed_job.${WorkflowState.GENERATING_DRAFT}`,
      })?.to,
    ).toBe(WorkflowState.GENERATING_DRAFT);
  });
});
