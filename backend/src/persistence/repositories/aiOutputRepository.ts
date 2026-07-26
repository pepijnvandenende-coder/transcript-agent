import { ApprovalStatus, type Prisma, type PolicyType, type RetryMode, type ValidationStatus } from "@prisma/client";
import { prisma } from "../prismaClient";

export function createAiOutput(params: {
  jobId?: string;
  workflowId: string;
  skillName: string;
  promptVersion: string;
  schemaVersion: string;
  rawOutput: Prisma.InputJsonValue;
  validationStatus: ValidationStatus;
  validationErrors?: Prisma.InputJsonValue;
  confidenceScore?: number;
  confidenceBreakdown?: Prisma.InputJsonValue;
  policyApplied?: PolicyType;
  attemptNumber?: number;
  retryOfAiOutputId?: string;
  retryMode?: RetryMode;
}) {
  return prisma.aiOutput.create({
    data: {
      jobId: params.jobId,
      workflowId: params.workflowId,
      skillName: params.skillName,
      promptVersion: params.promptVersion,
      schemaVersion: params.schemaVersion,
      rawOutput: params.rawOutput,
      validationStatus: params.validationStatus,
      validationErrors: params.validationErrors,
      confidenceScore: params.confidenceScore,
      confidenceBreakdown: params.confidenceBreakdown,
      policyApplied: params.policyApplied,
      attemptNumber: params.attemptNumber,
      retryOfAiOutputId: params.retryOfAiOutputId,
      retryMode: params.retryMode,
    },
  });
}

export function findAiOutputById(id: string) {
  return prisma.aiOutput.findUnique({ where: { id } });
}

export function findLatestAiOutputForWorkflow(workflowId: string, skillName: string) {
  return prisma.aiOutput.findFirst({
    where: { workflowId, skillName },
    orderBy: { createdAt: "desc" },
  });
}

// The Gateway auto-approved this output (auto_if_above met, or a
// deterministic auto-route like "insufficient") -- no human reviewed it, so
// approvedById stays null.
export function markAiOutputAutoApproved(id: string) {
  return prisma.aiOutput.update({
    where: { id },
    data: { approvalStatus: ApprovalStatus.AUTO_APPROVED, approvedAt: new Date() },
  });
}

// A human confirmed this output at the PENDING_HUMAN_CONFIRMATION checkpoint.
export function markAiOutputHumanApproved(id: string, approvedById: string) {
  return prisma.aiOutput.update({
    where: { id },
    data: { approvalStatus: ApprovalStatus.HUMAN_APPROVED, approvedById, approvedAt: new Date() },
  });
}

// Phase 3: attaches the reviewer's explanation to the OLD output being
// retried/edit-retried -- explaining why it wasn't confirmed, not describing
// the new attempt.
export function updateAiOutputReviewerComment(id: string, reviewerComment: string) {
  return prisma.aiOutput.update({
    where: { id },
    data: { reviewerComment },
  });
}
