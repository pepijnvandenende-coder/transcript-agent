import { PostProcessingResultStatus, type Prisma } from "@prisma/client";
import { prisma } from "../prismaClient";

// Phase 18: ONE generic result table for every follow-up skill -- see
// prisma/schema.prisma's PostProcessingResult comment for why this isn't a
// dedicated table per skill. Written by jobs/runners/postProcessingRunner.ts,
// not the gateway (same pattern as Merge/Draft/... -- see those repositories).
export function createPostProcessingResult(params: {
  workflowId: string;
  skillKey: string;
  status: PostProcessingResultStatus;
  aiOutputId?: string;
  resultJson?: Prisma.InputJsonValue;
  errorMessage?: string;
}) {
  return prisma.postProcessingResult.create({
    data: {
      workflowId: params.workflowId,
      skillKey: params.skillKey,
      status: params.status,
      aiOutputId: params.aiOutputId,
      resultJson: params.resultJson,
      errorMessage: params.errorMessage,
    },
  });
}

export function findPostProcessingResultsForWorkflow(workflowId: string) {
  return prisma.postProcessingResult.findMany({ where: { workflowId }, orderBy: { createdAt: "asc" } });
}
