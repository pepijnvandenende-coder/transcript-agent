import { ApprovalRequestStatus, type WorkflowState } from "@prisma/client";
import { prisma } from "../prismaClient";

export function createApprovalRequest(params: {
  workflowId: string;
  aiOutputId: string;
  intendedNextState: WorkflowState;
  // Seeded from the ai_output's computed attemptNumber (Phase 3) so a chain
  // of retries accumulates correctly across resolved episodes, rather than
  // resetting to 1 every time a new PENDING_HUMAN_CONFIRMATION episode
  // opens -- this is what makes max_retries enforcement meaningful.
  attemptCount?: number;
}) {
  return prisma.approvalRequest.create({
    data: {
      workflowId: params.workflowId,
      aiOutputId: params.aiOutputId,
      intendedNextState: params.intendedNextState,
      status: ApprovalRequestStatus.PENDING,
      attemptCount: params.attemptCount,
    },
  });
}

// A workflow has at most one open episode at a time -- PENDING_HUMAN_CONFIRMATION
// is a single checkpoint, and a resolved episode is never reopened.
export function findOpenApprovalRequest(workflowId: string) {
  return prisma.approvalRequest.findFirst({
    where: { workflowId, status: ApprovalRequestStatus.PENDING },
    orderBy: { createdAt: "desc" },
  });
}

export function resolveApprovalRequest(id: string, resolution: string) {
  return prisma.approvalRequest.update({
    where: { id },
    data: { status: ApprovalRequestStatus.RESOLVED, resolution, resolvedAt: new Date() },
  });
}
