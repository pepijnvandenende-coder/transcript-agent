import { prisma } from "../prismaClient";

// Versioned and insert-only, same rule as Merge/Conflict -- see
// jobs/runners/suggestReportTypeRunner.ts for the single write path.
export async function createReportTypeSuggestion(params: {
  workflowId: string;
  aiOutputId: string;
  suggestedType: string;
  rationale: string;
  runnerUp?: string;
}) {
  const latest = await prisma.reportTypeSuggestion.findFirst({
    where: { workflowId: params.workflowId },
    orderBy: { version: "desc" },
  });
  const version = (latest?.version ?? 0) + 1;

  return prisma.reportTypeSuggestion.create({
    data: {
      workflowId: params.workflowId,
      version,
      aiOutputId: params.aiOutputId,
      suggestedType: params.suggestedType,
      rationale: params.rationale,
      runnerUp: params.runnerUp,
    },
  });
}

// GET /workflows/:id/report-type-suggestion -- the latest suggestion, if any.
export function findLatestReportTypeSuggestion(workflowId: string) {
  return prisma.reportTypeSuggestion.findFirst({
    where: { workflowId },
    orderBy: { version: "desc" },
  });
}
