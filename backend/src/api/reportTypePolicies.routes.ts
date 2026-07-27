import { Router } from "express";
import { findActivePolicies } from "../persistence/repositories/reportTypePolicyRepository";
import { apiErrorHandler } from "./errorHandler";

// Mounted at /report-type-policies -- see api/app.ts. Not workflow-scoped:
// the catalog itself isn't tied to any one workflow (see
// prisma/schema.prisma's ReportTypePolicy model). Phase 13: backs the
// report-type picker that lets an operator deviate from the AI's suggestion
// (POST /workflows/:id/report-type already accepted any active catalog
// entry -- this just exposes the catalog itself to the frontend).
export const reportTypePoliciesRouter = Router();

reportTypePoliciesRouter.get("/", async (_req, res, next) => {
  try {
    const policies = await findActivePolicies();
    res.json(policies.map((policy) => ({ key: policy.key, displayName: policy.displayName })));
  } catch (err) {
    next(err);
  }
});

reportTypePoliciesRouter.use(apiErrorHandler);
