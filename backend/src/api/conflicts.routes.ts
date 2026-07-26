import { Router } from "express";
import { z } from "zod";
import { explainConflict, restartUpload } from "../approval/conflictResolution";
import { findConflictsForWorkflow } from "../persistence/repositories/conflictRepository";
import { findWorkflowById } from "../persistence/repositories/workflowRepository";
import { apiErrorHandler } from "./errorHandler";

// Mounted at /workflows -- see api/app.ts.
export const conflictsRouter = Router();

// GET /workflows/:id/conflicts -- full history (open + resolved) for this
// workflow, per the architecture doc's API list.
conflictsRouter.get("/:id/conflicts", async (req, res, next) => {
  try {
    const workflow = await findWorkflowById(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    const conflicts = await findConflictsForWorkflow(req.params.id);
    res.json(conflicts);
  } catch (err) {
    next(err);
  }
});

const explainSchema = z.object({ actorId: z.string().uuid(), explanation: z.string().min(1) });

// POST /workflows/:id/conflicts/:conflictId/explain -- Phase 4: resolves one
// conflict. See approval/conflictResolution.ts's explainConflict for the
// full semantics (only valid from CONFLICTS_PENDING_REVIEW, only advances to
// MERGING once every open conflict for the workflow is resolved).
conflictsRouter.post("/:id/conflicts/:conflictId/explain", async (req, res, next) => {
  try {
    const body = explainSchema.parse(req.body);
    const result = await explainConflict({
      workflowId: req.params.id,
      conflictId: req.params.conflictId,
      actorId: body.actorId,
      explanation: body.explanation,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

const restartUploadSchema = z.object({ actorId: z.string().uuid() });

// POST /workflows/:id/actions/restart-upload -- Phase 4: abandons this
// merge/conflict-review attempt and rewinds to TRANSCRIPT_UPLOADED. See
// approval/conflictResolution.ts's restartUpload.
conflictsRouter.post("/:id/actions/restart-upload", async (req, res, next) => {
  try {
    const body = restartUploadSchema.parse(req.body);
    const workflow = await restartUpload({ workflowId: req.params.id, actorId: body.actorId });
    res.json(workflow);
  } catch (err) {
    next(err);
  }
});

conflictsRouter.use(apiErrorHandler);
