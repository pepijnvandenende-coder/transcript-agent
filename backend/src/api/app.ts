import express from "express";
import { approvalRequestRouter } from "./approvalRequest.routes";
import { conflictsRouter } from "./conflicts.routes";
import { draftsRouter } from "./drafts.routes";
import { finalReportRouter } from "./finalReport.routes";
import { reportTypeRouter } from "./reportType.routes";
import { uploadsRouter } from "./uploads.routes";
import { validationRouter } from "./validation.routes";
import { workflowsRouter } from "./workflows.routes";

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/workflows", workflowsRouter);
  app.use("/workflows", uploadsRouter);
  app.use("/workflows", validationRouter);
  app.use("/workflows", approvalRequestRouter);
  app.use("/workflows", conflictsRouter);
  app.use("/workflows", reportTypeRouter);
  app.use("/workflows", draftsRouter);
  app.use("/workflows", finalReportRouter);
  return app;
}
