import { ActorType } from "@prisma/client";
import { NotAwaitingReportTypeSelectionError } from "../domain/types";
import { findLatestAiOutputForWorkflow, markAiOutputHumanApproved } from "../persistence/repositories/aiOutputRepository";
import { findWorkflowById, setWorkflowReportType } from "../persistence/repositories/workflowRepository";
import * as engine from "../workflow/engine";
import { WorkflowState } from "../workflow/states";
import { enqueueForStateEntry } from "./gateway";

const REPORT_TYPE_ADVISOR_SKILL_NAME = "ReportTypeAdvisor";

/**
 * AWAITING_REPORT_TYPE_SELECTION's own human action -- a distinct sub-domain
 * from the generic PENDING_HUMAN_CONFIRMATION checkpoint (ReportTypeAdvisor
 * never opens one; see gateway.ts's mandatoryReview shape), but still routes
 * through gateway.ts's enqueueForStateEntry() so landing on GENERATING_DRAFT
 * auto-starts DraftGenerator's job once a later phase registers it.
 *
 * This is the ONLY place workflows.report_type is ever set -- there is no
 * automatic selection anywhere in the codebase; it always requires this
 * explicit, human-submitted action.
 */
export async function selectReportType(params: {
  workflowId: string;
  actorId: string;
  reportType: string;
}): Promise<ReturnType<typeof engine.transition>> {
  const workflow = await findWorkflowById(params.workflowId);
  if (!workflow) {
    throw new Error(`Workflow ${params.workflowId} not found`);
  }
  if (workflow.currentState !== WorkflowState.AWAITING_REPORT_TYPE_SELECTION) {
    throw new NotAwaitingReportTypeSelectionError(params.workflowId, workflow.currentState);
  }

  await setWorkflowReportType(params.workflowId, params.reportType);

  // Finalizes the governance record for whichever ReportTypeAdvisor run
  // triggered this checkpoint -- mirrors confirmApprovalRequest marking an
  // output HUMAN_APPROVED at the generic checkpoint. The suggestion itself
  // (report_type_suggestions) is never mutated; this only updates ai_outputs'
  // own approval bookkeeping.
  const latestSuggestion = await findLatestAiOutputForWorkflow(params.workflowId, REPORT_TYPE_ADVISOR_SKILL_NAME);
  if (latestSuggestion) {
    await markAiOutputHumanApproved(latestSuggestion.id, params.actorId);
  }

  const updated = await engine.transition({
    workflowId: params.workflowId,
    trigger: { kind: "user_action", action: "select_report_type" },
    actor: { actorType: ActorType.USER, actorId: params.actorId },
    metadata: { reason: "report_type_selected", reportType: params.reportType },
  });
  await enqueueForStateEntry(params.workflowId, updated.currentState);
  return updated;
}
