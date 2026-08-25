import { Router } from "express";
import { findPostProcessingResultsForWorkflow } from "../persistence/repositories/postProcessingResultRepository";
import { findAllPostProcessingSkillPolicies } from "../persistence/repositories/postProcessingSkillPolicyRepository";
import { findWorkflowById } from "../persistence/repositories/workflowRepository";
import { apiErrorHandler } from "./errorHandler";

// Mounted at /workflows -- see api/app.ts. GET-only: results are written
// exclusively by jobs/runners/postProcessingRunner.ts on entering
// POST_PROCESSING, same "no manual trigger endpoint" shape as every other
// PROCESSING state's skill (auto-enqueued via enqueueForStateEntry).
export const postProcessingResultsRouter = Router();

postProcessingResultsRouter.get("/:id/post-processing-results", async (req, res, next) => {
  try {
    const workflow = await findWorkflowById(req.params.id);
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    const [results, policies] = await Promise.all([
      findPostProcessingResultsForWorkflow(workflow.id),
      findAllPostProcessingSkillPolicies(),
    ]);
    const displayNameByKey = new Map(policies.map((policy) => [policy.key, policy.displayName]));
    res.json(
      results.map((result) => ({
        ...result,
        displayName: displayNameByKey.get(result.skillKey) ?? result.skillKey,
      })),
    );
  } catch (err) {
    next(err);
  }
});

postProcessingResultsRouter.use(apiErrorHandler);
