import { ActorType, JobType } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { enqueue } from "../jobs/queue";
import { findLatestAiOutputForWorkflow } from "../persistence/repositories/aiOutputRepository";
import { findLatestTranscript } from "../persistence/repositories/transcriptRepository";
import { findWorkflowById } from "../persistence/repositories/workflowRepository";
import * as engine from "../workflow/engine";
import { apiErrorHandler } from "./errorHandler";

// Mounted at /workflows -- see api/app.ts.
export const validationRouter = Router();

const validateTranscriptSchema = z.object({ actorId: z.string().uuid() });

// POST /workflows/:id/actions/validate-transcript -- the plain user_action
// TRANSCRIPT_UPLOADED -> VALIDATING_TRANSCRIPT (engine.transition called
// directly here, exactly like the existing cancel route -- this is a human
// action, not an AI-driven move). Then enqueues the VALIDATE_TRANSCRIPT job
// for the latest transcript version; approval/gateway.ts decides the job's
// eventual outcome once it completes, not this route.
validationRouter.post("/:id/actions/validate-transcript", async (req, res, next) => {
  try {
    const body = validateTranscriptSchema.parse(req.body);

    const transcript = await findLatestTranscript(req.params.id);
    if (!transcript) {
      res.status(400).json({ error: "Workflow has no uploaded transcript to validate" });
      return;
    }

    const workflow = await engine.transition({
      workflowId: req.params.id,
      trigger: { kind: "user_action", action: "submit_for_validation" },
      actor: { actorType: ActorType.USER, actorId: body.actorId },
    });

    await enqueue({
      workflowId: req.params.id,
      jobType: JobType.VALIDATE_TRANSCRIPT,
      inputRef: transcript.id,
    });

    res.status(202).json(workflow);
  } catch (err) {
    next(err);
  }
});

// GET /workflows/:id/transcript/validation -- the latest ai_outputs row for
// this workflow's TranscriptQualityChecker run, if any.
validationRouter.get("/:id/transcript/validation", async (req, res, next) => {
  try {
    const workflow = await findWorkflowById(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    const aiOutput = await findLatestAiOutputForWorkflow(req.params.id, "TranscriptQualityChecker");
    if (!aiOutput) {
      res.status(404).json({ error: "No validation result yet for this workflow" });
      return;
    }
    res.json(aiOutput);
  } catch (err) {
    next(err);
  }
});

validationRouter.use(apiErrorHandler);
