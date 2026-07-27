import { Router } from "express";
import { z } from "zod";
import { confirmApprovalRequest, editRetryApprovalRequest, retryApprovalRequest } from "../approval/gateway";
import { getMaxRetries } from "../approval/policyResolver";
import { findAiOutputById } from "../persistence/repositories/aiOutputRepository";
import { findOpenApprovalRequest } from "../persistence/repositories/approvalRequestRepository";
import { findWorkflowById } from "../persistence/repositories/workflowRepository";
import { apiErrorHandler } from "./errorHandler";

// Mounted at /workflows -- see api/app.ts.
export const approvalRequestRouter = Router();

// GET /workflows/:id/approval-request -- the open episode, if any, plus the
// nested ai_output fields (skillName, validation/confidence data) and
// maxRetries a checkpoint UI (Phase 12: ConfirmLowConfidenceScreen) needs to
// explain the checkpoint and disable retry/edit-retry once the budget is
// spent. Reuses findAiOutputById()/getMaxRetries(), both already called by
// approval/gateway.ts -- no new repository code, no schema change.
approvalRequestRouter.get("/:id/approval-request", async (req, res, next) => {
  try {
    const workflow = await findWorkflowById(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    const openRequest = await findOpenApprovalRequest(req.params.id);
    if (!openRequest) {
      res.status(404).json({ error: "No open approval request for this workflow" });
      return;
    }
    const aiOutput = await findAiOutputById(openRequest.aiOutputId);
    if (!aiOutput) {
      res.status(500).json({ error: `ApprovalRequest ${openRequest.id} references missing ai_output ${openRequest.aiOutputId}` });
      return;
    }
    const maxRetries = await getMaxRetries(aiOutput.skillName);
    res.json({
      ...openRequest,
      aiOutput: {
        id: aiOutput.id,
        skillName: aiOutput.skillName,
        validationStatus: aiOutput.validationStatus,
        validationErrors: aiOutput.validationErrors,
        confidenceScore: aiOutput.confidenceScore,
        confidenceBreakdown: aiOutput.confidenceBreakdown,
        attemptNumber: aiOutput.attemptNumber,
      },
      maxRetries,
    });
  } catch (err) {
    next(err);
  }
});

const confirmSchema = z.object({ actorId: z.string().uuid() });

// POST /workflows/:id/approval-request/confirm -- Phase 2 locked decision:
// confirm only. See approval/gateway.ts's confirmApprovalRequest for the
// full semantics (only valid from PENDING_HUMAN_CONFIRMATION, never re-runs
// the AI skill, routes through the Gateway before engine.transition()).
approvalRequestRouter.post("/:id/approval-request/confirm", async (req, res, next) => {
  try {
    const body = confirmSchema.parse(req.body);
    const workflow = await confirmApprovalRequest({ workflowId: req.params.id, actorId: body.actorId });
    res.json(workflow);
  } catch (err) {
    next(err);
  }
});

const retrySchema = z.object({ actorId: z.string().uuid(), reviewerComment: z.string().min(1).optional() });

// POST /workflows/:id/approval-request/retry -- Phase 3: re-runs the same
// skill against the same input version(s). See approval/gateway.ts's
// retryApprovalRequest for the full semantics (checkpoint/open-request
// preconditions, max_retries enforcement, routing back through the
// originating PROCESSING state).
approvalRequestRouter.post("/:id/approval-request/retry", async (req, res, next) => {
  try {
    const body = retrySchema.parse(req.body);
    const workflow = await retryApprovalRequest({
      workflowId: req.params.id,
      actorId: body.actorId,
      reviewerComment: body.reviewerComment,
    });
    res.json(workflow);
  } catch (err) {
    next(err);
  }
});

const editRetrySchema = z
  .object({
    actorId: z.string().uuid(),
    transcriptContent: z.string().min(1).optional(),
    notesContent: z.string().min(1).optional(),
    reviewerComment: z.string().min(1).optional(),
  })
  .refine((body) => body.transcriptContent !== undefined || body.notesContent !== undefined, {
    message: "At least one of transcriptContent or notesContent is required",
  });

// POST /workflows/:id/approval-request/edit-retry -- Phase 3: records a new
// version of the edited input(s), then re-runs the skill against the new
// version(s). See approval/gateway.ts's editRetryApprovalRequest.
approvalRequestRouter.post("/:id/approval-request/edit-retry", async (req, res, next) => {
  try {
    const body = editRetrySchema.parse(req.body);
    const workflow = await editRetryApprovalRequest({
      workflowId: req.params.id,
      actorId: body.actorId,
      transcriptContent: body.transcriptContent,
      notesContent: body.notesContent,
      reviewerComment: body.reviewerComment,
    });
    res.json(workflow);
  } catch (err) {
    next(err);
  }
});

approvalRequestRouter.use(apiErrorHandler);
