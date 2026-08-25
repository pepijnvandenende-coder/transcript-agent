import { Router } from "express";
import { findActivePostProcessingSkillPolicies } from "../persistence/repositories/postProcessingSkillPolicyRepository";
import { apiErrorHandler } from "./errorHandler";

// Mounted at /post-processing-policies -- see api/app.ts. Not
// workflow-scoped, same shape as reportTypePolicies.routes.ts/
// contextTypePolicies.routes.ts. Mainly informational today (there is no
// per-workflow opt-out yet) -- lets the frontend describe which follow-up
// analyses will run.
export const postProcessingPoliciesRouter = Router();

postProcessingPoliciesRouter.get("/", async (_req, res, next) => {
  try {
    const policies = await findActivePostProcessingSkillPolicies();
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

postProcessingPoliciesRouter.use(apiErrorHandler);
