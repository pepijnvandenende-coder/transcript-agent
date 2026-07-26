import { ActorType } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { createNoteVersion } from "../persistence/repositories/noteRepository";
import { createTranscriptVersion } from "../persistence/repositories/transcriptRepository";
import { findWorkflowById } from "../persistence/repositories/workflowRepository";
import * as engine from "../workflow/engine";
import { apiErrorHandler } from "./errorHandler";

// Mounted at /workflows -- see api/app.ts.
export const uploadsRouter = Router();

const uploadSchema = z.object({
  uploadedById: z.string().uuid(),
  content: z.string().min(1),
});

// POST /workflows/:id/transcript -- Phase 2 accepts raw transcript text in
// the JSON body (no multipart/file handling yet). Stores it via the object
// storage adapter, records a new insert-only version row, and fires the
// CREATED -> TRANSCRIPT_UPLOADED transition (the "upload_transcript" user
// action already defined in workflow/transitions.ts) exactly the way
// workflows.routes.ts's cancel handler calls engine.transition() directly.
// Re-uploading once the workflow has already left CREATED still adds a new
// transcript version, but engine.transition() then rejects the action (no
// matching rule from a later state) with the usual 409 -- there is no
// separate "no-op" path here, matching the FSM's existing strictness.
uploadsRouter.post("/:id/transcript", async (req, res, next) => {
  try {
    const workflow = await findWorkflowById(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    const body = uploadSchema.parse(req.body);
    const transcript = await createTranscriptVersion({
      workflowId: workflow.id,
      uploadedById: body.uploadedById,
      content: body.content,
    });

    await engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "upload_transcript" },
      actor: { actorType: ActorType.USER, actorId: body.uploadedById },
    });

    res.status(201).json(transcript);
  } catch (err) {
    next(err);
  }
});

// POST /workflows/:id/notes -- same shape as transcript upload. Persisted
// this phase; not read by any skill until the Merger phase.
uploadsRouter.post("/:id/notes", async (req, res, next) => {
  try {
    const workflow = await findWorkflowById(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    const body = uploadSchema.parse(req.body);
    const note = await createNoteVersion({
      workflowId: workflow.id,
      uploadedById: body.uploadedById,
      content: body.content,
    });
    res.status(201).json(note);
  } catch (err) {
    next(err);
  }
});

uploadsRouter.use(apiErrorHandler);
