import { Router } from "express";
import { findFinalReportForWorkflow } from "../persistence/repositories/finalReportRepository";
import { findWorkflowById } from "../persistence/repositories/workflowRepository";
import { localFilesystemStorage } from "../storage/localFilesystemStorage";
import { apiErrorHandler } from "./errorHandler";

// Mounted at /workflows -- see api/app.ts.
export const finalReportRouter = Router();

// GET /workflows/:id/final-report -- metadata only. Plain existence checks,
// not FSM preconditions (there's no dedicated "not completed yet" error --
// a missing final_reports row is just a 404, same style as
// conflicts.routes.ts's/reportType.routes.ts's GET routes).
finalReportRouter.get("/:id/final-report", async (req, res, next) => {
  try {
    const workflow = await findWorkflowById(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    const finalReport = await findFinalReportForWorkflow(req.params.id);
    if (!finalReport) {
      res.status(404).json({ error: "Final report not available yet" });
      return;
    }
    res.json(finalReport);
  } catch (err) {
    next(err);
  }
});

// GET /workflows/:id/final-report/download -- the rendered file itself.
finalReportRouter.get("/:id/final-report/download", async (req, res, next) => {
  try {
    const workflow = await findWorkflowById(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    const finalReport = await findFinalReportForWorkflow(req.params.id);
    if (!finalReport) {
      res.status(404).json({ error: "Final report not available yet" });
      return;
    }
    const content = await localFilesystemStorage.getBinary(finalReport.storageRef);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", `attachment; filename="eindrapport-${req.params.id}.docx"`);
    res.send(content);
  } catch (err) {
    next(err);
  }
});

finalReportRouter.use(apiErrorHandler);
