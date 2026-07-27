import { ActorType } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { enqueueForStateEntry, originatingStateForJobType } from "../approval/gateway";
import { NoFailedJobFoundError, NotAtFailedStateError } from "../domain/types";
import { findLatestFailedJobForWorkflow, findLatestJobForWorkflow } from "../persistence/repositories/jobRepository";
import { listTransitionsForWorkflow } from "../persistence/repositories/stateTransitionRepository";
import { findWorkflowById } from "../persistence/repositories/workflowRepository";
import * as engine from "../workflow/engine";
import { WorkflowState } from "../workflow/states";
import { apiErrorHandler } from "./errorHandler";

export const workflowsRouter = Router();

const createWorkflowSchema = z.object({
  title: z.string().min(1),
  createdById: z.string().uuid(),
});

// POST /workflows -- create a new workflow, entering it at WorkflowState.CREATED.
workflowsRouter.post("/", async (req, res, next) => {
  try {
    const body = createWorkflowSchema.parse(req.body);
    const workflow = await engine.createWorkflow(body);
    res.status(201).json(workflow);
  } catch (err) {
    next(err);
  }
});

// GET /workflows/:id -- full workflow detail ("get workflow status").
workflowsRouter.get("/:id", async (req, res, next) => {
  try {
    const workflow = await findWorkflowById(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    res.json(workflow);
  } catch (err) {
    next(err);
  }
});

// GET /workflows/:id/state -- current state + the user-triggerable actions
// valid from it ("get allowed actions"). system_event triggers are excluded:
// those are raised internally by later-phase components, never by a caller.
workflowsRouter.get("/:id/state", async (req, res, next) => {
  try {
    const workflow = await findWorkflowById(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    res.json({
      currentState: workflow.currentState,
      allowedActions: engine.getAllowedActions(workflow.currentState),
    });
  } catch (err) {
    next(err);
  }
});

// GET /workflows/:id/history -- the full audit trail for this workflow.
workflowsRouter.get("/:id/history", async (req, res, next) => {
  try {
    const workflow = await findWorkflowById(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    const history = await listTransitionsForWorkflow(req.params.id);
    res.json(history);
  } catch (err) {
    next(err);
  }
});

// GET /workflows/:id/jobs/latest -- the workflow's most recent job (any
// status). Phase 13: lets the frontend explain *why* a workflow is waiting
// (queued behind other work vs. actively running) instead of a bare
// "processing" spinner, and surface a job's `error` once it has failed --
// see jobs/worker.ts's failJob() for where that error is written.
workflowsRouter.get("/:id/jobs/latest", async (req, res, next) => {
  try {
    const workflow = await findWorkflowById(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    const job = await findLatestJobForWorkflow(req.params.id);
    if (!job) {
      res.status(404).json({ error: "No job yet for this workflow" });
      return;
    }
    res.json(job);
  } catch (err) {
    next(err);
  }
});

const retryFailedJobSchema = z.object({ actorId: z.string().uuid() });

// POST /workflows/:id/actions/retry-failed-job -- the FAILED state's own
// recovery action, using the `retry_failed_job.<state>` edges
// workflow/transitions.ts has declared since Phase 1 (FAILURE_TRANSITIONS)
// but that, until Phase 13, nothing ever exposed a route for -- a failed job
// left the workflow permanently stuck at FAILED with no way forward. Re-runs
// the same job against the same input(s), same shape as
// approval/gateway.ts's retryApprovalRequest for the PENDING_HUMAN_CONFIRMATION
// checkpoint.
workflowsRouter.post("/:id/actions/retry-failed-job", async (req, res, next) => {
  try {
    const body = retryFailedJobSchema.parse(req.body);
    const workflow = await findWorkflowById(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    if (workflow.currentState !== WorkflowState.FAILED) {
      throw new NotAtFailedStateError(req.params.id, workflow.currentState);
    }

    const failedJob = await findLatestFailedJobForWorkflow(req.params.id);
    if (!failedJob) {
      throw new NoFailedJobFoundError(req.params.id);
    }
    const originatingState = originatingStateForJobType(failedJob.jobType);
    if (!originatingState) {
      throw new Error(`No originating WorkflowState registered for job type ${failedJob.jobType}`);
    }

    const updated = await engine.transition({
      workflowId: req.params.id,
      trigger: { kind: "user_action", action: `retry_failed_job.${originatingState}` },
      actor: { actorType: ActorType.USER, actorId: body.actorId },
      metadata: { reason: "human_retry_failed_job", failedJobId: failedJob.id },
    });
    await enqueueForStateEntry(req.params.id, updated.currentState);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

const cancelWorkflowSchema = z.object({
  actorId: z.string().uuid(),
  reason: z.string().optional(),
});

// POST /workflows/:id/cancel -- explicit human action, valid from any
// non-terminal state (see the generated cancel edges in transitions.ts).
workflowsRouter.post("/:id/cancel", async (req, res, next) => {
  try {
    const body = cancelWorkflowSchema.parse(req.body);
    const workflow = await engine.transition({
      workflowId: req.params.id,
      trigger: { kind: "user_action", action: "cancel" },
      actor: { actorType: ActorType.USER, actorId: body.actorId },
      metadata: body.reason ? { reason: body.reason } : undefined,
    });
    res.json(workflow);
  } catch (err) {
    next(err);
  }
});

workflowsRouter.use(apiErrorHandler);
