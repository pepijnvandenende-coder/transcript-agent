import type { ActorType, WorkflowState } from "@prisma/client";

/**
 * A trigger is either an explicit user-initiated action (arrived via the
 * API) or a system event (raised by the Approval Gateway / job workers in a
 * later phase, after they score an AI job's output). The engine treats both
 * uniformly: neither causes a transition unless it matches an edge declared
 * in workflow/transitions.ts.
 */
export type TransitionTrigger =
  | { kind: "user_action"; action: string }
  | { kind: "system_event"; event: string };

export interface ActorContext {
  actorType: ActorType;
  actorId?: string; // required in practice when actorType is USER
}

export interface TransitionRequest {
  workflowId: string;
  trigger: TransitionTrigger;
  actor: ActorContext;
  metadata?: Record<string, unknown>;
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly workflowId: string,
    public readonly fromState: WorkflowState,
    public readonly trigger: TransitionTrigger,
  ) {
    super(`No transition defined from state "${fromState}" for trigger ${JSON.stringify(trigger)}`);
    this.name = "InvalidTransitionError";
  }
}

// Phase 2: raised by approval/gateway.ts's confirmApprovalRequest when the
// workflow isn't currently at the PENDING_HUMAN_CONFIRMATION checkpoint --
// confirm only ever applies there.
export class NotAtCheckpointError extends Error {
  constructor(
    public readonly workflowId: string,
    public readonly currentState: WorkflowState,
  ) {
    super(
      `Workflow ${workflowId} is not at PENDING_HUMAN_CONFIRMATION (current state: ${currentState}); cannot confirm`,
    );
    this.name = "NotAtCheckpointError";
  }
}

// Phase 2: raised when a confirm is attempted but there is no open
// ApprovalRequest episode for the workflow to resolve.
export class NoOpenApprovalRequestError extends Error {
  constructor(public readonly workflowId: string) {
    super(`Workflow ${workflowId} has no open approval request to confirm`);
    this.name = "NoOpenApprovalRequestError";
  }
}

// Phase 3: raised by approval/gateway.ts's retryApprovalRequest /
// editRetryApprovalRequest when the open episode's attemptCount has already
// reached approval_policies.maxRetries -- the reviewer must confirm or
// cancel instead.
export class MaxRetriesExceededError extends Error {
  constructor(
    public readonly workflowId: string,
    public readonly maxRetries: number,
  ) {
    super(`Workflow ${workflowId} has reached the maximum of ${maxRetries} attempts; retry is disabled`);
    this.name = "MaxRetriesExceededError";
  }
}

// Phase 3: raised by editRetryApprovalRequest when the caller submits an
// input type (e.g. notes) that the checkpoint's skill doesn't consume (e.g.
// TranscriptQualityChecker, which never reads notes).
export class InvalidRetryInputError extends Error {
  constructor(
    public readonly skillName: string,
    public readonly inputType: string,
  ) {
    super(`Skill "${skillName}" does not consume "${inputType}" as an input; nothing to edit-retry`);
    this.name = "InvalidRetryInputError";
  }
}

// Phase 4: raised by approval/conflictResolution.ts's explainConflict()/
// restartUpload() when the workflow isn't at CONFLICTS_PENDING_REVIEW --
// mirrors NotAtCheckpointError's role for the generic checkpoint.
export class NotAtConflictReviewError extends Error {
  constructor(
    public readonly workflowId: string,
    public readonly currentState: WorkflowState,
  ) {
    super(
      `Workflow ${workflowId} is not at CONFLICTS_PENDING_REVIEW (current state: ${currentState}); cannot review conflicts`,
    );
    this.name = "NotAtConflictReviewError";
  }
}

// Phase 4: raised when explainConflict() is given a conflictId that doesn't
// belong to the given workflow (or doesn't exist at all).
export class ConflictNotFoundError extends Error {
  constructor(
    public readonly workflowId: string,
    public readonly conflictId: string,
  ) {
    super(`Conflict ${conflictId} not found for workflow ${workflowId}`);
    this.name = "ConflictNotFoundError";
  }
}

// Phase 4: raised when explainConflict() targets a conflict that's already
// RESOLVED -- each conflict can only be explained once.
export class ConflictAlreadyResolvedError extends Error {
  constructor(public readonly conflictId: string) {
    super(`Conflict ${conflictId} has already been resolved`);
    this.name = "ConflictAlreadyResolvedError";
  }
}

// Phase 5: raised by approval/reportTypeSelection.ts's selectReportType()
// when the workflow isn't at AWAITING_REPORT_TYPE_SELECTION -- mirrors
// NotAtConflictReviewError's role for CONFLICTS_PENDING_REVIEW.
export class NotAwaitingReportTypeSelectionError extends Error {
  constructor(
    public readonly workflowId: string,
    public readonly currentState: WorkflowState,
  ) {
    super(
      `Workflow ${workflowId} is not at AWAITING_REPORT_TYPE_SELECTION (current state: ${currentState}); cannot select a report type`,
    );
    this.name = "NotAwaitingReportTypeSelectionError";
  }
}

// Phase 6: raised by POST /workflows/:id/report-type when the submitted
// value doesn't match any active report_type_policies row (by key or Dutch
// displayName) -- selection is tightened to the catalog rather than
// accepting freeform text, per the Phase 6 decision.
export class UnknownReportTypeError extends Error {
  constructor(public readonly submittedValue: string) {
    super(`"${submittedValue}" does not match any active report type policy`);
    this.name = "UnknownReportTypeError";
  }
}
