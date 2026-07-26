import { ConflictStatus } from "@prisma/client";
import { prisma } from "../prismaClient";

// Conflicts are never deleted -- see prisma/schema.prisma's Conflict model
// comment. Created via individual create() calls (not createMany) so callers
// get back the created rows' ids immediately, needed by
// jobs/runners/conflictDetectionRunner.ts and its tests.
export function createConflicts(params: {
  workflowId: string;
  aiOutputId: string;
  conflicts: Array<{ description: string; sourceA?: string; sourceB?: string }>;
}) {
  return Promise.all(
    params.conflicts.map((conflict) =>
      prisma.conflict.create({
        data: {
          workflowId: params.workflowId,
          aiOutputId: params.aiOutputId,
          description: conflict.description,
          sourceA: conflict.sourceA,
          sourceB: conflict.sourceB,
        },
      }),
    ),
  );
}

// GET /workflows/:id/conflicts -- full history, open and resolved.
export function findConflictsForWorkflow(workflowId: string) {
  return prisma.conflict.findMany({
    where: { workflowId },
    orderBy: { createdAt: "asc" },
  });
}

export function findOpenConflicts(workflowId: string) {
  return prisma.conflict.findMany({
    where: { workflowId, status: ConflictStatus.OPEN },
  });
}

export function findConflictById(id: string) {
  return prisma.conflict.findUnique({ where: { id } });
}

export function resolveConflict(id: string, params: { resolution: string; resolvedById: string }) {
  return prisma.conflict.update({
    where: { id },
    data: {
      status: ConflictStatus.RESOLVED,
      resolution: params.resolution,
      resolvedById: params.resolvedById,
      resolvedAt: new Date(),
    },
  });
}

// Fired by approval/conflictResolution.ts's restartUpload() -- marks any
// still-open conflicts resolved with a distinct resolution tag, rather than
// deleting them, so they remain part of the workflow's audit history.
export function supersedeOpenConflicts(workflowId: string, resolvedById: string) {
  return prisma.conflict.updateMany({
    where: { workflowId, status: ConflictStatus.OPEN },
    data: {
      status: ConflictStatus.RESOLVED,
      resolution: "superseded_by_restart",
      resolvedById,
      resolvedAt: new Date(),
    },
  });
}
