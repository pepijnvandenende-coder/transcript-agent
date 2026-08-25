import { prisma } from "../prismaClient";
import { localFilesystemStorage } from "../../storage/localFilesystemStorage";

// Generic, catalog-driven additional context (see prisma/schema.prisma's
// ContextItem comment for why this is deliberately separate from
// noteRepository.ts). Versioned per (workflowId, contextType), mirroring
// noteRepository.ts's per-workflow versioning -- but scoped to one type at a
// time, so submitting a new "normenkader" version never touches the
// "vragenlijst" version history.
export async function createContextItemVersion(params: {
  workflowId: string;
  contextType: string;
  uploadedById: string;
  content: string;
}) {
  const latest = await prisma.contextItem.findFirst({
    where: { workflowId: params.workflowId, contextType: params.contextType },
    orderBy: { version: "desc" },
  });
  const version = (latest?.version ?? 0) + 1;
  const storageRef = `${params.workflowId}/context/${params.contextType}/v${version}.txt`;

  await localFilesystemStorage.put(storageRef, params.content);

  return prisma.contextItem.create({
    data: {
      workflowId: params.workflowId,
      contextType: params.contextType,
      version,
      storageRef,
      uploadedById: params.uploadedById,
    },
  });
}

export function findLatestContextItem(workflowId: string, contextType: string) {
  return prisma.contextItem.findFirst({
    where: { workflowId, contextType },
    orderBy: { version: "desc" },
  });
}

// Used by draftGenerationRunner.ts to gather every type's latest version at
// once, and by GET /workflows/:id/context to show what's already been
// submitted. Fetches every row for the workflow and reduces to one (the
// highest version) per contextType in application code, rather than a SQL
// DISTINCT ON -- the per-workflow row count is small (one per context type
// submitted) and this keeps the query portable/simple, consistent with the
// rest of this codebase's repositories.
export async function findLatestContextItemsForWorkflow(workflowId: string) {
  const items = await prisma.contextItem.findMany({
    where: { workflowId },
    orderBy: { version: "asc" },
  });
  const latestByType = new Map<string, (typeof items)[number]>();
  for (const item of items) {
    latestByType.set(item.contextType, item);
  }
  return Array.from(latestByType.values());
}
