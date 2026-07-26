import type { Prisma } from "@prisma/client";
import { prisma } from "../prismaClient";

// One row per DraftQualityPrecheck run, tied to the exact Draft version it
// annotates -- see draftQualityPrecheckRunner.ts for the single write path.
export function createDraftPrecheck(params: {
  workflowId: string;
  draftId: string;
  aiOutputId: string;
  overallScore: number;
  checklist: Prisma.InputJsonValue;
  blockingIssues: Prisma.InputJsonValue;
  recommendation: string;
}) {
  return prisma.draftPrecheck.create({
    data: {
      workflowId: params.workflowId,
      draftId: params.draftId,
      aiOutputId: params.aiOutputId,
      overallScore: params.overallScore,
      checklist: params.checklist,
      blockingIssues: params.blockingIssues,
      recommendation: params.recommendation,
    },
  });
}

// Read by GET /workflows/:id/drafts(/:version) to join the latest annotation
// for a given draft version into the response.
export function findLatestPrecheckForDraft(draftId: string) {
  return prisma.draftPrecheck.findFirst({
    where: { draftId },
    orderBy: { createdAt: "desc" },
  });
}
