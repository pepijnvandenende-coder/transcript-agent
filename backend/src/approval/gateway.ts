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
import { checkSchema } from "./schemaValidator";

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
  };
  /** The state a confirm/auto-approve of this skill's output always leads to. */
  nextState: WorkflowState;
  /** This skill's own PROCESSING state -- where retry/edit-retry route back to. */
  originatingState: WorkflowState;
  confirmAction: string;
  retryAction: string;
  editRetryAction: string;
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
 * States with no registered skill (e.g. DETECTING_CONFLICTS, until a later
 * phase adds ConflictDetector) simply no-op here.
 */
async function enqueueForStateEntry(
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
}): Promise<{ aiOutputId: string }> {
  const routing = routingFor(params.envelope.skill);

  let attemptNumber = 1;
  if (params.retryOfAiOutputId) {
    const previous = await findAiOutputById(params.retryOfAiOutputId);
    attemptNumber = (previous?.attemptNumber ?? 0) + 1;
  }

  const schemaCheck = checkSchema(params.envelope.skill, params.envelope);

  if (!schemaCheck.valid) {
    const aiOutput = await createAiOutput({
      jobId: params.jobId,
      workflowId: params.workflowId,
      skillName: params.envelope.skill,
      promptVersion: params.promptVersion,
      schemaVersion: params.schemaVersion,
      rawOutput: params.envelope as unknown as Prisma.InputJsonValue,
      validationStatus: ValidationStatus.INVALID,
      validationErrors: schemaCheck.errors as Prisma.InputJsonValue,
      attemptNumber,
      retryOfAiOutputId: params.retryOfAiOutputId,
      retryMode: params.retryMode,
    });
    if (params.inputs?.length) {
      await createAiOutputInputs(aiOutput.id, params.inputs);
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
    trigger: { kind: "user_action", action: routing.confirmAction },
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
    trigger: { kind: "user_action", action: routing.retryAction },
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
    trigger: { kind: "user_action", action: routing.editRetryAction },
    actor: { actorType: ActorType.USER, actorId: params.actorId },
    metadata: { reason: "human_edit_retry", aiOutputId: aiOutput.id, approvalRequestId: openRequest.id },
  });
  await enqueueForStateEntry(params.workflowId, updated.currentState, {
    retryOfAiOutputId: aiOutput.id,
    retryMode: RetryMode.EDITED_INPUT,
  });
  return updated;
}
