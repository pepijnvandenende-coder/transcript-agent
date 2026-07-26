import { prisma } from "../prismaClient";

export function listTransitionsForWorkflow(workflowId: string) {
  return prisma.stateTransition.findMany({
    where: { workflowId },
    orderBy: { occurredAt: "asc" },
  });
}
