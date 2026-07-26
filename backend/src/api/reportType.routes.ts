import { Router } from "express";
import { z } from "zod";
import { selectReportType } from "../approval/reportTypeSelection";
import { findLatestReportTypeSuggestion } from "../persistence/repositories/reportTypeSuggestionRepository";
import { findWorkflowById } from "../persistence/repositories/workflowRepository";
import { apiErrorHandler } from "./errorHandler";

// Mounted at /workflows -- see api/app.ts.
export const reportTypeRouter = Router();

// GET /workflows/:id/report-type-suggestion -- the latest ReportTypeAdvisor
// suggestion for this workflow, if any.
reportTypeRouter.get("/:id/report-type-suggestion", async (req, res, next) => {
  try {
    const workflow = await findWorkflowById(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    const suggestion = await findLatestReportTypeSuggestion(req.params.id);
    if (!suggestion) {
      res.status(404).json({ error: "No report type suggestion yet for this workflow" });
      return;
    }
    res.json(suggestion);
  } catch (err) {
    next(err);
  }
});

const selectReportTypeSchema = z.object({ actorId: z.string().uuid(), reportType: z.string().min(1) });

// POST /workflows/:id/report-type -- the human's explicit report type
// choice. Phase 6: tightened from Phase 5's freeform acceptance -- the
// submitted value (English key or Dutch displayName) must resolve against
// the report_type_policies catalog; see
// approval/reportTypeSelection.ts's selectReportType for the full semantics
// (only valid from AWAITING_REPORT_TYPE_SELECTION, advances to GENERATING_DRAFT,
// 400s via UnknownReportTypeError for an unrecognized value).
reportTypeRouter.post("/:id/report-type", async (req, res, next) => {
  try {
    const body = selectReportTypeSchema.parse(req.body);
    const workflow = await selectReportType({
      workflowId: req.params.id,
      actorId: body.actorId,
      reportType: body.reportType,
    });
    res.json(workflow);
  } catch (err) {
    next(err);
  }
});

reportTypeRouter.use(apiErrorHandler);
