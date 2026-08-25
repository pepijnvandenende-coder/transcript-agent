import { ActorType } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { findContextTypePolicyByKey } from "../persistence/repositories/contextTypePolicyRepository";
import {
  createContextItemVersion,
  findLatestContextItemsForWorkflow,
} from "../persistence/repositories/contextItemRepository";
import { findWorkflowById } from "../persistence/repositories/workflowRepository";
import * as engine from "../workflow/engine";
import { apiErrorHandler } from "./errorHandler";

// Mounted at /workflows -- see api/app.ts. The explicit, generic context
// step (Phase 18): additional context types (PvA, normenkader, vragenlijst,
// ...) beyond the existing Notes upload (uploads.routes.ts, left unchanged).
// Same shape as uploads.routes.ts's POST /notes -- submitting a context item
// never triggers an FSM transition itself, context stays optional and
// non-blocking per type, matching how Notes has always worked. Reused
// unchanged by draftGenerationRunner.ts once the workflow reaches
// GENERATING_DRAFT, and by postProcessingRunner.ts for skills whose catalog
// row declares a `requiresContextType`.
//
// Phase 19: what *is* now mandatory is passing through the CONTEXT_INPUT
// step itself -- see workflow/transitions.ts's "continue_to_transcript" and
// "back_to_context" edges, exposed below as the two action routes that move
// a workflow into/out of it. Neither route requires any context to have
// been submitted first.
export const contextRouter = Router();

const contextUploadSchema = z.object({
  uploadedById: z.string().uuid(),
  contextType: z.string().min(1),
  content: z.string().min(1),
});

contextRouter.post("/:id/context", async (req, res, next) => {
  try {
    const workflow = await findWorkflowById(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    const body = contextUploadSchema.parse(req.body);

    const policy = await findContextTypePolicyByKey(body.contextType);
    if (!policy || !policy.isActive) {
      res.status(400).json({ error: `Unknown or inactive context type "${body.contextType}"` });
      return;
    }

    const contextItem = await createContextItemVersion({
      workflowId: workflow.id,
      contextType: body.contextType,
      uploadedById: body.uploadedById,
      content: body.content,
    });

    res.status(201).json(contextItem);
  } catch (err) {
    next(err);
  }
});

// GET /workflows/:id/context -- metadata (not content) for every context
// type already submitted, latest version each. Lets the frontend show what's
// already there without re-fetching raw file content, same scope decision as
// most of this API's other GET list routes.
contextRouter.get("/:id/context", async (req, res, next) => {
  try {
    const workflow = await findWorkflowById(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    const items = await findLatestContextItemsForWorkflow(workflow.id);
    res.json(items);
  } catch (err) {
    next(err);
  }
});

const contextStepActionSchema = z.object({ actorId: z.string().uuid() });

// POST /workflows/:id/actions/continue-to-transcript -- the CONTEXT_INPUT ->
// CREATED user action. Valid regardless of whether any context/notes were
// actually submitted this step -- "doorgaan zonder context" is a fully
// supported path, not a fallback. Plain engine.transition() call, same
// pattern as validation.routes.ts's validate-transcript route; an attempt
// from any other state falls through to InvalidTransitionError -> 409, same
// as every other FSM action route.
contextRouter.post("/:id/actions/continue-to-transcript", async (req, res, next) => {
  try {
    const body = contextStepActionSchema.parse(req.body);
    const workflow = await engine.transition({
      workflowId: req.params.id,
      trigger: { kind: "user_action", action: "continue_to_transcript" },
      actor: { actorType: ActorType.USER, actorId: body.actorId },
    });
    res.json(workflow);
  } catch (err) {
    next(err);
  }
});

// POST /workflows/:id/actions/back-to-context -- the mirror CREATED ->
// CONTEXT_INPUT edge, used by the transcript screen's back control. Already-
// submitted context items/notes are untouched by this (they live in their
// own tables, keyed by workflowId, not by currentState).
contextRouter.post("/:id/actions/back-to-context", async (req, res, next) => {
  try {
    const body = contextStepActionSchema.parse(req.body);
    const workflow = await engine.transition({
      workflowId: req.params.id,
      trigger: { kind: "user_action", action: "back_to_context" },
      actor: { actorType: ActorType.USER, actorId: body.actorId },
    });
    res.json(workflow);
  } catch (err) {
    next(err);
  }
});

contextRouter.use(apiErrorHandler);
