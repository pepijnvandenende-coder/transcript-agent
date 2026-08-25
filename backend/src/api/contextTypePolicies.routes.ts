import { Router } from "express";
import { findActiveContextTypePolicies } from "../persistence/repositories/contextTypePolicyRepository";
import { apiErrorHandler } from "./errorHandler";

// Mounted at /context-type-policies -- see api/app.ts. Not workflow-scoped,
// same shape as reportTypePolicies.routes.ts. Backs the frontend's context
// step: which additional context types are offered is entirely driven by
// this catalog's active rows.
export const contextTypePoliciesRouter = Router();

contextTypePoliciesRouter.get("/", async (_req, res, next) => {
  try {
    const policies = await findActiveContextTypePolicies();
    res.json(
      policies.map((policy) => ({
        key: policy.key,
        displayName: policy.displayName,
        description: policy.description,
      })),
    );
  } catch (err) {
    next(err);
  }
});

contextTypePoliciesRouter.use(apiErrorHandler);
