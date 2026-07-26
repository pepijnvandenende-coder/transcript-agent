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
