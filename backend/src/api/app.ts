import express from "express";
import { approvalRequestRouter } from "./approvalRequest.routes";
import { conflictsRouter } from "./conflicts.routes";
import { contextRouter } from "./context.routes";
import { contextTypePoliciesRouter } from "./contextTypePolicies.routes";
import { draftsRouter } from "./drafts.routes";
import { finalReportRouter } from "./finalReport.routes";
import { postProcessingPoliciesRouter } from "./postProcessingPolicies.routes";
import { postProcessingResultsRouter } from "./postProcessingResults.routes";
import { reportTypeRouter } from "./reportType.routes";
import { reportTypePoliciesRouter } from "./reportTypePolicies.routes";
import { uploadsRouter } from "./uploads.routes";
import { usersRouter } from "./users.routes";
import { validationRouter } from "./validation.routes";
import { workflowsRouter } from "./workflows.routes";

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/workflows", workflowsRouter);
  app.use("/workflows", uploadsRouter);
  app.use("/workflows", contextRouter);
  app.use("/context-type-policies", contextTypePoliciesRouter);
  app.use("/workflows", validationRouter);
  app.use("/workflows", approvalRequestRouter);
  app.use("/workflows", conflictsRouter);
  app.use("/workflows", reportTypeRouter);
  app.use("/report-type-policies", reportTypePoliciesRouter);
  app.use("/workflows", draftsRouter);
  app.use("/workflows", finalReportRouter);
  app.use("/workflows", postProcessingResultsRouter);
  app.use("/post-processing-policies", postProcessingPoliciesRouter);
  app.use("/users", usersRouter);
  return app;
}
