import type { WorkflowStatus } from "@prisma/client";
import { prisma } from "../prismaClient";

export function findWorkflowById(id: string) {
  return prisma.workflow.findUnique({ where: { id } });
}

export function listWorkflows(filter?: { status?: WorkflowStatus }) {
  return prisma.workflow.findMany({
    where: filter?.status ? { status: filter.status } : undefined,
    orderBy: { createdAt: "desc" },
  });
}

// Phase 5: sets the human's actual report-type choice, distinct from
// report_type_suggestions (the AI's suggestion history). engine.transition()
// only ever touches currentState/status, so business fields like this are
// set via their own dedicated repository call -- see
// approval/reportTypeSelection.ts's selectReportType().
export function setWorkflowReportType(workflowId: string, reportType: string) {
  return prisma.workflow.update({
    where: { id: workflowId },
    data: { reportType },
  });
}
