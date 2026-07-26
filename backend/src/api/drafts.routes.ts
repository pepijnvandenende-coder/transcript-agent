import { Router } from "express";
import { z } from "zod";
import { approveDraft, requestDraftChanges } from "../approval/draftReview";
import { findLatestPrecheckForDraft } from "../persistence/repositories/draftPrecheckRepository";
import { findAllDraftsForWorkflow, findDraftByVersion } from "../persistence/repositories/draftRepository";
import { findWorkflowById } from "../persistence/repositories/workflowRepository";
import { apiErrorHandler } from "./errorHandler";

// Mounted at /workflows -- see api/app.ts.
export const draftsRouter = Router();

async function withPrecheck(draft: NonNullable<Awaited<ReturnType<typeof findDraftByVersion>>>) {
  const precheck = await findLatestPrecheckForDraft(draft.id);
  return { ...draft, precheck };
}

// GET /workflows/:id/drafts -- full version history for this workflow, each
// annotated with its latest DraftQualityPrecheck result if one exists yet.
draftsRouter.get("/:id/drafts", async (req, res, next) => {
  try {
    const workflow = await findWorkflowById(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    const drafts = await findAllDraftsForWorkflow(req.params.id);
    res.json(await Promise.all(drafts.map(withPrecheck)));
  } catch (err) {
    next(err);
  }
});

// GET /workflows/:id/drafts/:version -- a specific draft version.
draftsRouter.get("/:id/drafts/:version", async (req, res, next) => {
  try {
    const workflow = await findWorkflowById(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    const version = Number(req.params.version);
    const draft = Number.isInteger(version) ? await findDraftByVersion(req.params.id, version) : null;
    if (!draft) {
      res.status(404).json({ error: "Draft version not found" });
      return;
    }
    res.json(await withPrecheck(draft));
  } catch (err) {
    next(err);
  }
});

const reviewSchema = z
  .object({
    actorId: z.string().uuid(),
    decision: z.enum(["approve", "request_changes"]),
    feedback: z.string().min(1).optional(),
  })
  .refine((body) => body.decision !== "request_changes" || Boolean(body.feedback), {
    message: "feedback is required when decision is 'request_changes'",
    path: ["feedback"],
  });

// POST /workflows/:id/drafts/:version/review -- Phase 7: the DRAFT_PENDING_REVIEW
// checkpoint's own two human actions. See approval/draftReview.ts for the full
// semantics (only valid from DRAFT_PENDING_REVIEW, only against the current
// latest draft version).
draftsRouter.post("/:id/drafts/:version/review", async (req, res, next) => {
  try {
    const body = reviewSchema.parse(req.body);
    const version = Number(req.params.version);
    if (!Number.isInteger(version)) {
      res.status(400).json({ error: "Invalid draft version" });
      return;
    }

    const updated =
      body.decision === "approve"
        ? await approveDraft({ workflowId: req.params.id, actorId: body.actorId, version })
        : await requestDraftChanges({
            workflowId: req.params.id,
            actorId: body.actorId,
            version,
            feedback: body.feedback!,
          });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

draftsRouter.use(apiErrorHandler);
