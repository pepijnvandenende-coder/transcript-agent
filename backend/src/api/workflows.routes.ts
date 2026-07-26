import { ActorType } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { listTransitionsForWorkflow } from "../persistence/repositories/stateTransitionRepository";
import { findWorkflowById } from "../persistence/repositories/workflowRepository";
import * as engine from "../workflow/engine";
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
