import type { Prisma } from "@prisma/client";
import { prisma } from "../prismaClient";

// Merges are versioned and insert-only, same rule as transcripts/notes, but
// AI-produced -- see jobs/runners/mergeRunner.ts for the single write path.
export async function createMergeVersion(params: {
  workflowId: string;
  aiOutputId: string;
  mergedSections: Prisma.InputJsonValue;
  unmatchedNotes: Prisma.InputJsonValue;
}) {
  const latest = await prisma.merge.findFirst({
    where: { workflowId: params.workflowId },
    orderBy: { version: "desc" },
  });
  const version = (latest?.version ?? 0) + 1;

  return prisma.merge.create({
    data: {
      workflowId: params.workflowId,
      version,
      aiOutputId: params.aiOutputId,
      mergedSections: params.mergedSections,
      unmatchedNotes: params.unmatchedNotes,
    },
  });
}

// Unused until Phase 4 (ConflictDetector reads the merge output), added now
// so the repository shape doesn't need to change alongside that phase.
export function findLatestMerge(workflowId: string) {
  return prisma.merge.findFirst({
    where: { workflowId },
    orderBy: { version: "desc" },
  });
}
