import { prisma } from "../prismaClient";

// One row per completed workflow -- see jobs/runners/finalRendererRunner.ts
// for the single write path. Never versioned/mutated: COMPLETED is terminal
// with no re-entry edge back into GENERATING_FINAL.
export function createFinalReport(params: {
  workflowId: string;
  draftId: string;
  aiOutputId: string;
  title: string;
  format: string;
  storageRef: string;
}) {
  return prisma.finalReport.create({
    data: {
      workflowId: params.workflowId,
      draftId: params.draftId,
      aiOutputId: params.aiOutputId,
      title: params.title,
      format: params.format,
      storageRef: params.storageRef,
    },
  });
}

export function findFinalReportForWorkflow(workflowId: string) {
  return prisma.finalReport.findUnique({ where: { workflowId } });
}
