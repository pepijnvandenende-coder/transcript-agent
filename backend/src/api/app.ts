import express from "express";
import { approvalRequestRouter } from "./approvalRequest.routes";
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
  return app;
}
