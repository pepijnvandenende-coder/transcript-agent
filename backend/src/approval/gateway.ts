import { ActorType, AiOutputInputType, JobType, type Prisma, RetryMode, ValidationStatus } from "@prisma/client";
import type { SkillEnvelope } from "../ai/skillEnvelope";
import { InvalidRetryInputError, MaxRetriesExceededError, NoOpenApprovalRequestError, NotAtCheckpointError } from "../domain/types";
import { enqueue } from "../jobs/queue";
import {
  createAiOutput,
  findAiOutputById,
  markAiOutputAutoApproved,
  markAiOutputHumanApproved,
  updateAiOutputReviewerComment,
} from "../persistence/repositories/aiOutputRepository";
import { createAiOutputInputs } from "../persistence/repositories/aiOutputInputRepository";
import {
  createApprovalRequest,
  findOpenApprovalRequest,
  resolveApprovalRequest,
} from "../persistence/repositories/approvalRequestRepository";
import { createNoteVersion } from "../persistence/repositories/noteRepository";
import { createTranscriptVersion } from "../persistence/repositories/transcriptRepository";
import { findWorkflowById } from "../persistence/repositories/workflowRepository";
import * as engine from "../workflow/engine";
import { WorkflowState } from "../workflow/states";
import { computeConfidence } from "./confidenceScorer";
import { getMaxRetries, resolvePolicy } from "./policyResolver";
import { checkSchema, type SchemaCheckResult } from "./schemaValidator";

// Per-skill wiring the routing logic below needs: the system_event names
// transitions.ts declares for this step's outcomes, the user_actions
// PENDING_HUMAN_CONFIRMATION resolves to for this skill (confirm/retry/
// edit-retry), the job this skill's own PROCESSING state (originatingState)
// runs, and which input types it consumes (for edit-retry validation and
// ai_output_inputs lineage). Each skill registers its own entry rather than
// growing a chain of if/else.
interface SkillRouting {
  events: {
    autoApproved: string;
    lowConfidence: string;
    schemaInvalid: string;
    insufficient?: string;
    /** Phase 4: fired on the "requires_review" policy outcome -- see policyResolver.ts. */
    requiresReview?: string;
    /**
     * Phase 5/7: fired for skills whose PROCESSING state has no
     * PENDING_HUMAN_CONFIRMATION edge to fall back to on schema-invalid
     * output (e.g. ReportTypeAdvisor's AWAITING_REPORT_TYPE_SELECTION,
     * DraftQualityPrecheck's DRAFT_PENDING_REVIEW) -- fired unconditionally
     * on schema-invalid (there's nowhere else for it to go), and ALSO fired
     * on schema-valid output whenever `policyResolution.outcome` isn't
     * `"auto_approved"` (see handleSkillOutput() below). For MANDATORY-policy
     * skills, outcome is always `"mandatory"`, so this always fires and the
     * output stays PENDING (a human hasn't made the required explicit choice
     * yet). For ADVISORY_ONLY skills (outcome is always `"auto_approved"`),
     * this condition is never met on the valid path -- they fall through to
     * the normal auto_approved handling instead, which is what "never gates"
     * actually means for them.
     */
    bypassEvent?: string;
  };
  /** The state a confirm/auto-approve of this skill's output always leads to. */
  nextState: WorkflowState;
  /** This skill's own PROCESSING state -- where retry/edit-retry route back to. */
  originatingState: WorkflowState;
  // Optional (Phase 5): skills whose events.bypassEvent is set never open a
  // PENDING_HUMAN_CONFIRMATION episode, so confirm/retry/edit-retry are
  // unreachable for them and these fields are never read.
  confirmAction?: string;
  retryAction?: string;
  editRetryAction?: string;
  jobType: JobType;
  inputs: AiOutputInputType[];
}

const SKILL_ROUTING: Record<string, SkillRouting> = {
  TranscriptQualityChecker: {
    events: {
      autoApproved: "transcript_validation.auto_approved",
      lowConfidence: "transcript_validation.low_confidence",
      schemaInvalid: "transcript_validation.schema_invalid",
      insufficient: "transcript_validation.insufficient",
    },
    nextState: WorkflowState.MERGING,
    originatingState: WorkflowState.VALIDATING_TRANSCRIPT,
    confirmAction: "confirm.transcript_validation",
    retryAction: "retry.transcript_validation",
    editRetryAction: "edit_retry.transcript_validation",
    jobType: JobType.VALIDATE_TRANSCRIPT,
    inputs: [AiOutputInputType.TRANSCRIPT],
  },
  Merger: {
    events: {
      autoApproved: "merge.auto_approved",
      lowConfidence: "merge.low_confidence",
      schemaInvalid: "merge.schema_invalid",
    },
    nextState: WorkflowState.DETECTING_CONFLICTS,
    originatingState: WorkflowState.MERGING,
    confirmAction: "confirm.merge",
    retryAction: "retry.merge",
    editRetryAction: "edit_retry.merge",
    jobType: JobType.MERGE,
    inputs: [AiOutputInputType.TRANSCRIPT, AiOutputInputType.NOTES],
  },
  ConflictDetector: {
    events: {
      autoApproved: "conflict_detection.none_found_auto_approved",
      lowConfidence: "conflict_detection.none_found_low_confidence",
      schemaInvalid: "conflict_detection.schema_invalid",
      requiresReview: "conflict_detection.conflicts_found",
    },
    nextState: WorkflowState.SUGGESTING_REPORT_TYPE,
    originatingState: WorkflowState.DETECTING_CONFLICTS,
    confirmAction: "confirm.conflict_detection",
    retryAction: "retry.conflict_detection",
    editRetryAction: "edit_retry.conflict_detection",
    jobType: JobType.DETECT_CONFLICTS,
    // ConflictDetector reads the latest `merges` output, not a transcript/notes
    // version directly -- there's no editable input type for it yet (Phase 4
    // scope decision), so edit-retry against its checkpoint always rejects
    // via InvalidRetryInputError, with no special-casing needed.
    inputs: [],
  },
  ReportTypeAdvisor: {
    events: {
      // Unused (bypassEvent fires first -- outcome is always "mandatory" for
      // this MANDATORY-policy skill) but kept non-empty strings rather than
      // making the whole `events` shape conditional -- simplest way to
      // satisfy the existing required fields without a second SkillRouting
      // variant.
      autoApproved: "report_type_suggested",
      lowConfidence: "report_type_suggested",
      schemaInvalid: "report_type_suggested",
      bypassEvent: "report_type_suggested",
    },
    nextState: WorkflowState.AWAITING_REPORT_TYPE_SELECTION,
    originatingState: WorkflowState.SUGGESTING_REPORT_TYPE,
    jobType: JobType.SUGGEST_REPORT_TYPE,
    // Reads the latest `merges` output, same lineage scope decision Phase 4
    // made for ConflictDetector -- no new AiOutputInputType.
    inputs: [],
  },
  DraftGenerator: {
    events: {
      // Unused (bypassEvent fires first -- same reasoning as ReportTypeAdvisor
      // above) -- same placeholder pattern.
      autoApproved: "draft_generated",
      lowConfidence: "draft_generated",
      schemaInvalid: "draft_generated",
      bypassEvent: "draft_generated",
    },
    nextState: WorkflowState.DRAFT_QUALITY_PRECHECK,
    originatingState: WorkflowState.GENERATING_DRAFT,
    jobType: JobType.GENERATE_DRAFT,
    // Reads the latest `merges` output, same lineage scope decision as
    // ConflictDetector/ReportTypeAdvisor -- no new AiOutputInputType.
    inputs: [],
  },
  DraftQualityPrecheck: {
    events: {
      // ADVISORY_ONLY -- policyResolver.ts resolves this skill's outcome to
      // "auto_approved" unconditionally, so autoApproved is the event that
      // actually fires on the valid path (see handleSkillOutput()'s
      // bypassEvent condition below). lowConfidence/schemaInvalid are unused
      // placeholders, same pattern as ReportTypeAdvisor/DraftGenerator above.
      autoApproved: "precheck_completed",
      lowConfidence: "precheck_completed",
      schemaInvalid: "precheck_completed",
      // Used on the schema-invalid path only (there's no
      // PENDING_HUMAN_CONFIRMATION edge for DRAFT_QUALITY_PRECHECK to fall
      // back to) -- never used on the valid path, since this skill's outcome
      // is always "auto_approved".
      bypassEvent: "precheck_completed",
    },
    nextState: WorkflowState.DRAFT_PENDING_REVIEW,
    originatingState: WorkflowState.DRAFT_QUALITY_PRECHECK,
    jobType: JobType.DRAFT_QUALITY_PRECHECK,
    // Reads the latest `drafts` output, same lineage scope decision as
    // ConflictDetector/ReportTypeAdvisor/DraftGenerator -- no new AiOutputInputType.
    inputs: [],
  },
  DraftReviser: {
    events: {
      // Unused (bypassEvent fires first -- MANDATORY policy, outcome is
      // always "mandatory") -- same placeholder pattern as DraftGenerator's
      // entry above.
      autoApproved: "draft_revised",
      lowConfidence: "draft_revised",
      schemaInvalid: "draft_revised",
      bypassEvent: "draft_revised",
    },
    nextState: WorkflowState.DRAFT_QUALITY_PRECHECK,
    originatingState: WorkflowState.REVISING_DRAFT,
    jobType: JobType.REVISE_DRAFT,
    // Reads the latest `drafts` output + review_feedback, same lineage scope
    // decision as ConflictDetector/ReportTypeAdvisor/DraftGenerator/
    // DraftQualityPrecheck -- no new AiOutputInputType.
    inputs: [],
  },
  FinalRenderer: {
    events: {
      // AUTO -- policyResolver.ts resolves this skill's outcome to
      // "auto_approved" unconditionally, so autoApproved is the event that
      // actually fires on the valid path, same shape as DraftQualityPrecheck's
      // entry above. lowConfidence/schemaInvalid are unused placeholders.
      autoApproved: "final_rendered",
      lowConfidence: "final_rendered",
      schemaInvalid: "final_rendered",
      // Used on the schema-invalid path only (there's no
      // PENDING_HUMAN_CONFIRMATION edge for GENERATING_FINAL to fall back
      // to) -- never used on the valid path, since this skill's outcome is
      // always "auto_approved".
      bypassEvent: "final_rendered",
    },
    nextState: WorkflowState.COMPLETED,
    originatingState: WorkflowState.GENERATING_FINAL,
    jobType: JobType.RENDER_FINAL,
    // Reads the latest `drafts` output, same lineage scope decision as every
    // later-phase skill above -- no new AiOutputInputType.
    inputs: [],
  },
};

function routingFor(skillName: string): SkillRouting {
  const routing = SKILL_ROUTING[skillName];
  if (!routing) throw new Error(`No Gateway routing configured for skill "${skillName}"`);
  return routing;
}

// Derived from SKILL_ROUTING rather than hand-listed, so a new skill's
// originatingState/jobType entry is the only place that needs to change for
// its PROCESSING state to start auto-enqueuing jobs on entry.
const JOB_FOR_STATE: Partial<Record<WorkflowState, JobType>> = Object.fromEntries(
  Object.values(SKILL_ROUTING).map((routing) => [routing.originatingState, routing.jobType]),
);

/**
 * Called after every engine.transition() in this file, keyed off the
 * transition's ACTUAL resulting state (not an assumed target) -- so it stays
 * correct even if transitions.ts routing ever changes. This is what starts a
 * skill's job the moment its PROCESSING state is entered, whether that
 * happens via auto-approval, a human confirm, or a retry/edit-retry -- there
 * is no separate "start merge"-style endpoint for any state past the first.
 * States with no registered skill simply no-op here.
 *
 * Exported (Phase 4) so human actions that are NOT AI-output-driven -- e.g.
 * approval/conflictResolution.ts's explainConflict(), which transitions
 * CONFLICTS_PENDING_REVIEW -> MERGING directly via engine.transition() --
 * can still restart the next skill's job on entry, through this same single
 * choke point, rather than duplicating the auto-enqueue logic.
 */
export async function enqueueForStateEntry(
  workflowId: string,
  state: WorkflowState,
  retryContext?: { retryOfAiOutputId: string; retryMode: RetryMode },
): Promise<void> {
  const jobType = JOB_FOR_STATE[state];
  if (!jobType) return;
  await enqueue({ workflowId, jobType, ...retryContext });
}

/**
 * The Human Approval Layer's on_job_complete orchestration, per the
 * architecture doc: schema validation, then (if valid) confidence scoring
 * and policy resolution, then either an automatic FSM transition or opening
 * a PENDING_HUMAN_CONFIRMATION checkpoint. This is the ONLY function
 * (besides confirmApprovalRequest/retryApprovalRequest/editRetryApprovalRequest
 * below) permitted to call engine.transition() for an AI-driven move -- raw
 * skill output never reaches the Workflow Engine directly.
 */
export async function handleSkillOutput(params: {
  workflowId: string;
  jobId?: string;
  envelope: SkillEnvelope;
  promptVersion: string;
  schemaVersion: string;
  // Phase 3: set when this run was triggered by a retry/edit-retry at
  // PENDING_HUMAN_CONFIRMATION, so this output's attempt_number/retry lineage
  // can be computed from the output it's retrying.
  retryOfAiOutputId?: string;
  retryMode?: RetryMode;
  // Phase 3: the exact versioned input(s) this run consumed, for
  // ai_output_inputs lineage. Optional -- not every skill/runner populates it
  // yet (see mergeRunner.ts vs validateTranscriptRunner.ts).
  inputs?: Array<{ inputType: AiOutputInputType; inputId: string; inputVersion: number }>;
  // Phase 6: an optional extra check run only when the zod schema check
  // already passed -- e.g. draftGenerationRunner.ts's
  // reportStructureValidator.ts call, which needs the resolved
  // ReportTypePolicy's requiredSections (not available to the generic,
  // skill-agnostic checkSchema() below). A failure here is folded into the
  // exact same INVALID/schema-invalid handling as a zod failure, so gateway.ts
  // never needs to know what the check actually validated.
  additionalValidation?: () => SchemaCheckResult;
}): Promise<{ aiOutputId: string }> {
  const routing = routingFor(params.envelope.skill);

  let attemptNumber = 1;
  if (params.retryOfAiOutputId) {
    const previous = await findAiOutputById(params.retryOfAiOutputId);
    attemptNumber = (previous?.attemptNumber ?? 0) + 1;
  }

  const schemaCheck = checkSchema(params.envelope.skill, params.envelope);
  const validationResult: SchemaCheckResult = schemaCheck.valid
    ? (params.additionalValidation?.() ?? { valid: true })
    : schemaCheck;

  if (!validationResult.valid) {
    const aiOutput = await createAiOutput({
      jobId: params.jobId,
      workflowId: params.workflowId,
      skillName: params.envelope.skill,
      promptVersion: params.promptVersion,
      schemaVersion: params.schemaVersion,
      rawOutput: params.envelope as unknown as Prisma.InputJsonValue,
      validationStatus: ValidationStatus.INVALID,
      validationErrors: validationResult.errors as Prisma.InputJsonValue,
      attemptNumber,
      retryOfAiOutputId: params.retryOfAiOutputId,
      retryMode: params.retryMode,
    });
    if (params.inputs?.length) {
      await createAiOutputInputs(aiOutput.id, params.inputs);
    }

    if (routing.events.bypassEvent) {
      // Phase 5/7: skills whose checkpoint isn't the generic one (e.g.
      // ReportTypeAdvisor, DraftQualityPrecheck) proceed straight to their
      // dedicated next state even on schema-invalid output -- there is no
      // PENDING_HUMAN_CONFIRMATION edge for these states to route a failure
      // to (see gateway.ts's SkillRouting.events.bypassEvent doc comment).
      // validationStatus/validationErrors above still fully audit the
      // invalid output; no approval_requests episode is opened.
      const updated = await engine.transition({
        workflowId: params.workflowId,
        trigger: { kind: "system_event", event: routing.events.bypassEvent },
        actor: { actorType: ActorType.SYSTEM },
        metadata: { reason: "schema_invalid", aiOutputId: aiOutput.id },
      });
      await enqueueForStateEntry(params.workflowId, updated.currentState);
      return { aiOutputId: aiOutput.id };
    }

    await createApprovalRequest({
      workflowId: params.workflowId,
      aiOutputId: aiOutput.id,
      intendedNextState: routing.nextState,
      attemptCount: attemptNumber,
    });

    const updated = await engine.transition({
      workflowId: params.workflowId,
      trigger: { kind: "system_event", event: routing.events.schemaInvalid },
      actor: { actorType: ActorType.SYSTEM },
      metadata: { reason: "schema_invalid", aiOutputId: aiOutput.id },
    });
    await enqueueForStateEntry(params.workflowId, updated.currentState);

    return { aiOutputId: aiOutput.id };
  }

  const result = params.envelope.result as Record<string, unknown>;
  const breakdown = computeConfidence(params.envelope.confidence);
  const policyResolution = await resolvePolicy({
    skillName: params.envelope.skill,
    result,
    confidence: breakdown.confidence,
  });

  const aiOutput = await createAiOutput({
    jobId: params.jobId,
    workflowId: params.workflowId,
    skillName: params.envelope.skill,
    promptVersion: params.promptVersion,
    schemaVersion: params.schemaVersion,
    rawOutput: params.envelope as unknown as Prisma.InputJsonValue,
    validationStatus: ValidationStatus.VALID,
    confidenceScore: breakdown.confidence,
    confidenceBreakdown: breakdown as unknown as Prisma.InputJsonValue,
    policyApplied: policyResolution.policyType,
    attemptNumber,
    retryOfAiOutputId: params.retryOfAiOutputId,
    retryMode: params.retryMode,
  });
  if (params.inputs?.length) {
    await createAiOutputInputs(aiOutput.id, params.inputs);
  }

  if (routing.events.bypassEvent && policyResolution.outcome !== "auto_approved") {
    // Phase 5/7: proceeds regardless of confidence or policy outcome, EXCEPT
    // when the outcome is "auto_approved" -- that case is left to the normal
    // auto_approved branch below, which is what lets an ADVISORY_ONLY skill
    // (e.g. DraftQualityPrecheck, whose outcome is always "auto_approved")
    // genuinely auto-approve instead of being forced through this
    // unconditional path meant for MANDATORY skills like ReportTypeAdvisor/
    // DraftGenerator (whose outcome is always "mandatory", so this condition
    // is always true for them: never auto-approved, since a human hasn't made
    // the required explicit choice yet, and never a generic approval_requests
    // episode). This is what makes their destination state a true mandatory
    // human decision point rather than an auto-advancing step.
    const updated = await engine.transition({
      workflowId: params.workflowId,
      trigger: { kind: "system_event", event: routing.events.bypassEvent },
      actor: { actorType: ActorType.SYSTEM },
      metadata: { reason: "bypass", aiOutputId: aiOutput.id },
    });
    await enqueueForStateEntry(params.workflowId, updated.currentState);
    return { aiOutputId: aiOutput.id };
  }

  if (policyResolution.outcome === "requires_review") {
    // Mandatory human checkpoint (e.g. CONFLICTS_PENDING_REVIEW) -- unlike
    // "insufficient" below, this does NOT auto-approve (a human hasn't
    // reviewed anything yet) and does NOT open a generic approval_requests
    // episode, since PENDING_HUMAN_CONFIRMATION's confirm/retry/edit-retry
    // semantics don't apply to this checkpoint. approvalStatus stays PENDING
    // until whatever skill-specific review flow resolves it (e.g.
    // approval/conflictResolution.ts marks it HUMAN_APPROVED once every
    // conflict is explained). The caller (e.g. conflictDetectionRunner.ts) is
    // responsible for writing whatever skill-specific rows back this review.
    const updated = await engine.transition({
      workflowId: params.workflowId,
      trigger: { kind: "system_event", event: routing.events.requiresReview! },
      actor: { actorType: ActorType.SYSTEM },
      metadata: { reason: "requires_review", aiOutputId: aiOutput.id },
    });
    await enqueueForStateEntry(params.workflowId, updated.currentState);
    return { aiOutputId: aiOutput.id };
  }

  if (policyResolution.outcome === "insufficient") {
    await markAiOutputAutoApproved(aiOutput.id);
    const updated = await engine.transition({
      workflowId: params.workflowId,
      trigger: { kind: "system_event", event: routing.events.insufficient! },
      actor: { actorType: ActorType.SYSTEM },
      metadata: { reason: "insufficient", aiOutputId: aiOutput.id },
    });
    await enqueueForStateEntry(params.workflowId, updated.currentState);
    return { aiOutputId: aiOutput.id };
  }

  if (policyResolution.outcome === "auto_approved") {
    await markAiOutputAutoApproved(aiOutput.id);
    const updated = await engine.transition({
      workflowId: params.workflowId,
      trigger: { kind: "system_event", event: routing.events.autoApproved },
      actor: { actorType: ActorType.SYSTEM },
      metadata: { reason: "auto_approved", aiOutputId: aiOutput.id },
    });
    await enqueueForStateEntry(params.workflowId, updated.currentState);
    return { aiOutputId: aiOutput.id };
  }

  // low_confidence or mandatory: both open the same generic checkpoint --
  // transitions.ts has no separate "mandatory" edge for this step, since the
  // FSM doesn't distinguish the two reasons for reaching it.
  await createApprovalRequest({
    workflowId: params.workflowId,
    aiOutputId: aiOutput.id,
    intendedNextState: routing.nextState,
    attemptCount: attemptNumber,
  });
  const updated = await engine.transition({
    workflowId: params.workflowId,
    trigger: { kind: "system_event", event: routing.events.lowConfidence },
    actor: { actorType: ActorType.SYSTEM },
    metadata: { reason: policyResolution.outcome, aiOutputId: aiOutput.id },
  });
  await enqueueForStateEntry(params.workflowId, updated.currentState);
  return { aiOutputId: aiOutput.id };
}

/**
 * Shared preconditions for confirm/retry/edit-retry: the workflow must be at
 * PENDING_HUMAN_CONFIRMATION with an open episode, and that episode's
 * ai_output must resolve to a registered skill's routing.
 */
async function loadOpenCheckpoint(workflowId: string) {
  const workflow = await findWorkflowById(workflowId);
  if (!workflow) {
    throw new Error(`Workflow ${workflowId} not found`);
  }
  if (workflow.currentState !== WorkflowState.PENDING_HUMAN_CONFIRMATION) {
    throw new NotAtCheckpointError(workflowId, workflow.currentState);
  }

  const openRequest = await findOpenApprovalRequest(workflowId);
  if (!openRequest) {
    throw new NoOpenApprovalRequestError(workflowId);
  }

  const aiOutput = await findAiOutputById(openRequest.aiOutputId);
  if (!aiOutput) {
    throw new Error(`ApprovalRequest ${openRequest.id} references missing ai_output ${openRequest.aiOutputId}`);
  }
  const routing = routingFor(aiOutput.skillName);

  return { workflow, openRequest, aiOutput, routing };
}

async function assertRetryBudget(
  workflowId: string,
  skillName: string,
  openRequest: { attemptCount: number },
): Promise<void> {
  const maxRetries = await getMaxRetries(skillName);
  if (openRequest.attemptCount >= maxRetries) {
    throw new MaxRetriesExceededError(workflowId, maxRetries);
  }
}

/**
 * Phase 2 locked decision: confirm only works from PENDING_HUMAN_CONFIRMATION,
 * never re-runs the AI skill, and (like handleSkillOutput above) is the
 * Gateway's own responsibility to call engine.transition() -- the API route
 * never calls the engine directly for this action.
 */
export async function confirmApprovalRequest(params: {
  workflowId: string;
  actorId: string;
}): Promise<ReturnType<typeof engine.transition>> {
  const { openRequest, aiOutput, routing } = await loadOpenCheckpoint(params.workflowId);

  await markAiOutputHumanApproved(aiOutput.id, params.actorId);
  await resolveApprovalRequest(openRequest.id, "confirmed");

  const updated = await engine.transition({
    workflowId: params.workflowId,
    trigger: { kind: "user_action", action: routing.confirmAction! },
    actor: { actorType: ActorType.USER, actorId: params.actorId },
    metadata: { reason: "human_confirmed", aiOutputId: aiOutput.id, approvalRequestId: openRequest.id },
  });
  await enqueueForStateEntry(params.workflowId, updated.currentState);
  return updated;
}

/**
 * Phase 3: re-runs the same skill against the same input version(s). Routes
 * back through the originating PROCESSING state so the full Gateway logic
 * (schema validation, confidence scoring, policy resolution) re-runs on the
 * new attempt, rather than bypassing it -- the new ai_outputs row is created
 * by handleSkillOutput() once the re-enqueued job completes, not here.
 */
export async function retryApprovalRequest(params: {
  workflowId: string;
  actorId: string;
  reviewerComment?: string;
}): Promise<ReturnType<typeof engine.transition>> {
  const { openRequest, aiOutput } = await loadOpenCheckpoint(params.workflowId);
  await assertRetryBudget(params.workflowId, aiOutput.skillName, openRequest);
  const routing = routingFor(aiOutput.skillName);

  if (params.reviewerComment) {
    await updateAiOutputReviewerComment(aiOutput.id, params.reviewerComment);
  }
  await resolveApprovalRequest(openRequest.id, "retried");

  const updated = await engine.transition({
    workflowId: params.workflowId,
    trigger: { kind: "user_action", action: routing.retryAction! },
    actor: { actorType: ActorType.USER, actorId: params.actorId },
    metadata: { reason: "human_retry", aiOutputId: aiOutput.id, approvalRequestId: openRequest.id },
  });
  await enqueueForStateEntry(params.workflowId, updated.currentState, {
    retryOfAiOutputId: aiOutput.id,
    retryMode: RetryMode.SAME_INPUT,
  });
  return updated;
}

/**
 * Phase 3: like retryApprovalRequest, but first records a new version of
 * whichever input(s) the reviewer is editing (validated against the
 * checkpoint's skill's declared `inputs`), then re-runs against the new
 * version(s). All previous input and output versions are preserved --
 * nothing is overwritten.
 */
export async function editRetryApprovalRequest(params: {
  workflowId: string;
  actorId: string;
  transcriptContent?: string;
  notesContent?: string;
  reviewerComment?: string;
}): Promise<ReturnType<typeof engine.transition>> {
  const { openRequest, aiOutput } = await loadOpenCheckpoint(params.workflowId);
  await assertRetryBudget(params.workflowId, aiOutput.skillName, openRequest);
  const routing = routingFor(aiOutput.skillName);

  if (params.transcriptContent !== undefined && !routing.inputs.includes(AiOutputInputType.TRANSCRIPT)) {
    throw new InvalidRetryInputError(aiOutput.skillName, "transcript");
  }
  if (params.notesContent !== undefined && !routing.inputs.includes(AiOutputInputType.NOTES)) {
    throw new InvalidRetryInputError(aiOutput.skillName, "notes");
  }

  if (params.transcriptContent !== undefined) {
    await createTranscriptVersion({
      workflowId: params.workflowId,
      uploadedById: params.actorId,
      content: params.transcriptContent,
    });
  }
  if (params.notesContent !== undefined) {
    await createNoteVersion({
      workflowId: params.workflowId,
      uploadedById: params.actorId,
      content: params.notesContent,
    });
  }

  if (params.reviewerComment) {
    await updateAiOutputReviewerComment(aiOutput.id, params.reviewerComment);
  }
  await resolveApprovalRequest(openRequest.id, "edited_input");

  const updated = await engine.transition({
    workflowId: params.workflowId,
    trigger: { kind: "user_action", action: routing.editRetryAction! },
    actor: { actorType: ActorType.USER, actorId: params.actorId },
    metadata: { reason: "human_edit_retry", aiOutputId: aiOutput.id, approvalRequestId: openRequest.id },
  });
  await enqueueForStateEntry(params.workflowId, updated.currentState, {
    retryOfAiOutputId: aiOutput.id,
    retryMode: RetryMode.EDITED_INPUT,
  });
  return updated;
}
