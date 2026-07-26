import type { TransitionTrigger } from "../domain/types";
import { ALL_STATES, isTerminalState, WorkflowState } from "./states";

export interface TransitionRule {
  from: WorkflowState;
  trigger: TransitionTrigger;
  to: WorkflowState;
  /**
   * Who is allowed to raise this trigger. Kept local to this table (rather
   * than imported from Prisma's ActorType) so the FSM definition has no
   * dependency beyond itself and domain/types.
   */
  actorType: "system" | "user";
}

function userAction(from: WorkflowState, action: string, to: WorkflowState): TransitionRule {
  return { from, trigger: { kind: "user_action", action }, to, actorType: "user" };
}

function systemEvent(from: WorkflowState, event: string, to: WorkflowState): TransitionRule {
  return { from, trigger: { kind: "system_event", event }, to, actorType: "system" };
}

/**
 * The FSM's hand-authored edges, per the approved architecture. This is the
 * ONLY place these transitions are declared -- guards.ts only ever looks
 * rules up here, it never encodes transition logic itself, and engine.ts
 * never decides a transition without going through guards.ts first.
 *
 * Two categories of trigger:
 *  - user_action: something a human explicitly did, via the API.
 *  - system_event: something the Approval Gateway (built in a later phase)
 *    raises after scoring an AI job's output. Phase 1 has no AI integration,
 *    so nothing raises these yet in production -- but the edges must exist
 *    now so the full FSM can be validated and tested ahead of that work.
 */
const CORE_TRANSITIONS: TransitionRule[] = [
  userAction(WorkflowState.CREATED, "upload_transcript", WorkflowState.TRANSCRIPT_UPLOADED),

  userAction(WorkflowState.TRANSCRIPT_UPLOADED, "submit_for_validation", WorkflowState.VALIDATING_TRANSCRIPT),

  systemEvent(WorkflowState.VALIDATING_TRANSCRIPT, "transcript_validation.auto_approved", WorkflowState.MERGING),
  systemEvent(
    WorkflowState.VALIDATING_TRANSCRIPT,
    "transcript_validation.low_confidence",
    WorkflowState.PENDING_HUMAN_CONFIRMATION,
  ),
  systemEvent(
    WorkflowState.VALIDATING_TRANSCRIPT,
    "transcript_validation.schema_invalid",
    WorkflowState.PENDING_HUMAN_CONFIRMATION,
  ),
  systemEvent(
    WorkflowState.VALIDATING_TRANSCRIPT,
    "transcript_validation.insufficient",
    WorkflowState.TRANSCRIPT_INSUFFICIENT,
  ),

  userAction(WorkflowState.TRANSCRIPT_INSUFFICIENT, "reupload_transcript", WorkflowState.TRANSCRIPT_UPLOADED),

  // PENDING_HUMAN_CONFIRMATION is one generic, reusable checkpoint entered by
  // every AUTO_IF_ABOVE step that came back low-confidence or schema-invalid.
  // Each action is qualified by the originating step (e.g. "confirm.merge")
  // because "confirm" must resolve to a different next state depending on
  // which step opened the request. Qualifying the action name keeps
  // (state, trigger) -> single target fully deterministic, rather than
  // trusting a caller-supplied target state.
  userAction(WorkflowState.PENDING_HUMAN_CONFIRMATION, "confirm.transcript_validation", WorkflowState.MERGING),
  userAction(
    WorkflowState.PENDING_HUMAN_CONFIRMATION,
    "retry.transcript_validation",
    WorkflowState.VALIDATING_TRANSCRIPT,
  ),
  userAction(
    WorkflowState.PENDING_HUMAN_CONFIRMATION,
    "edit_retry.transcript_validation",
    WorkflowState.VALIDATING_TRANSCRIPT,
  ),

  userAction(WorkflowState.PENDING_HUMAN_CONFIRMATION, "confirm.merge", WorkflowState.DETECTING_CONFLICTS),
  userAction(WorkflowState.PENDING_HUMAN_CONFIRMATION, "retry.merge", WorkflowState.MERGING),
  userAction(WorkflowState.PENDING_HUMAN_CONFIRMATION, "edit_retry.merge", WorkflowState.MERGING),

  userAction(
    WorkflowState.PENDING_HUMAN_CONFIRMATION,
    "confirm.conflict_detection",
    WorkflowState.SUGGESTING_REPORT_TYPE,
  ),
  userAction(WorkflowState.PENDING_HUMAN_CONFIRMATION, "retry.conflict_detection", WorkflowState.DETECTING_CONFLICTS),
  userAction(
    WorkflowState.PENDING_HUMAN_CONFIRMATION,
    "edit_retry.conflict_detection",
    WorkflowState.DETECTING_CONFLICTS,
  ),

  systemEvent(WorkflowState.MERGING, "merge.auto_approved", WorkflowState.DETECTING_CONFLICTS),
  systemEvent(WorkflowState.MERGING, "merge.low_confidence", WorkflowState.PENDING_HUMAN_CONFIRMATION),
  systemEvent(WorkflowState.MERGING, "merge.schema_invalid", WorkflowState.PENDING_HUMAN_CONFIRMATION),

  systemEvent(
    WorkflowState.DETECTING_CONFLICTS,
    "conflict_detection.conflicts_found",
    WorkflowState.CONFLICTS_PENDING_REVIEW,
  ),
  systemEvent(
    WorkflowState.DETECTING_CONFLICTS,
    "conflict_detection.none_found_auto_approved",
    WorkflowState.SUGGESTING_REPORT_TYPE,
  ),
  systemEvent(
    WorkflowState.DETECTING_CONFLICTS,
    "conflict_detection.none_found_low_confidence",
    WorkflowState.PENDING_HUMAN_CONFIRMATION,
  ),
  systemEvent(
    WorkflowState.DETECTING_CONFLICTS,
    "conflict_detection.schema_invalid",
    WorkflowState.PENDING_HUMAN_CONFIRMATION,
  ),

  userAction(WorkflowState.CONFLICTS_PENDING_REVIEW, "explain_conflict", WorkflowState.MERGING),
  userAction(WorkflowState.CONFLICTS_PENDING_REVIEW, "restart_upload", WorkflowState.TRANSCRIPT_UPLOADED),

  systemEvent(
    WorkflowState.SUGGESTING_REPORT_TYPE,
    "report_type_suggested",
    WorkflowState.AWAITING_REPORT_TYPE_SELECTION,
  ),

  userAction(WorkflowState.AWAITING_REPORT_TYPE_SELECTION, "select_report_type", WorkflowState.GENERATING_DRAFT),

  systemEvent(WorkflowState.GENERATING_DRAFT, "draft_generated", WorkflowState.DRAFT_QUALITY_PRECHECK),

  // DRAFT_QUALITY_PRECHECK is ADVISORY_ONLY: it never gates, so it has
  // exactly one outgoing edge, taken unconditionally once the precheck job
  // completes.
  systemEvent(WorkflowState.DRAFT_QUALITY_PRECHECK, "precheck_completed", WorkflowState.DRAFT_PENDING_REVIEW),

  userAction(WorkflowState.DRAFT_PENDING_REVIEW, "approve_draft", WorkflowState.GENERATING_FINAL),
  userAction(WorkflowState.DRAFT_PENDING_REVIEW, "request_draft_changes", WorkflowState.REVISING_DRAFT),

  systemEvent(WorkflowState.REVISING_DRAFT, "draft_revised", WorkflowState.DRAFT_QUALITY_PRECHECK),

  systemEvent(WorkflowState.GENERATING_FINAL, "final_rendered", WorkflowState.COMPLETED),
];

/**
 * Every PROCESSING state can fail its underlying job (an infrastructure-level
 * failure, distinct from the confidence-based routing above) and can be
 * retried back into itself. Generated from a list rather than hand-written
 * per state so adding a new PROCESSING state can't silently forget its
 * failure/retry pair -- this is still a fixed table computed once at module
 * load, not a decision the engine makes at runtime.
 */
const PROCESSING_STATES: WorkflowState[] = [
  WorkflowState.VALIDATING_TRANSCRIPT,
  WorkflowState.MERGING,
  WorkflowState.DETECTING_CONFLICTS,
  WorkflowState.SUGGESTING_REPORT_TYPE,
  WorkflowState.GENERATING_DRAFT,
  WorkflowState.DRAFT_QUALITY_PRECHECK,
  WorkflowState.REVISING_DRAFT,
  WorkflowState.GENERATING_FINAL,
];

const FAILURE_TRANSITIONS: TransitionRule[] = PROCESSING_STATES.flatMap((state) => [
  systemEvent(state, `job_failed.${state}`, WorkflowState.FAILED),
  userAction(WorkflowState.FAILED, `retry_failed_job.${state}`, state),
]);

/**
 * CANCELLED is reachable via an explicit user action from any non-terminal
 * state. Generated (not hand-listed) for the same reason as above: the
 * "cancel from anywhere" guarantee can't drift out of sync as states change.
 */
const CANCEL_TRANSITIONS: TransitionRule[] = ALL_STATES.filter((state) => !isTerminalState(state)).map((state) =>
  userAction(state, "cancel", WorkflowState.CANCELLED),
);

export const TRANSITIONS: readonly TransitionRule[] = [
  ...CORE_TRANSITIONS,
  ...FAILURE_TRANSITIONS,
  ...CANCEL_TRANSITIONS,
];
