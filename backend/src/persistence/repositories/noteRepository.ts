import { prisma } from "../prismaClient";
import { localFilesystemStorage } from "../../storage/localFilesystemStorage";

// Same insert-only versioning rule as transcriptRepository.ts. Notes are
// persisted starting Phase 2 but not read by any skill until the Merger
// phase.
export async function createNoteVersion(params: { workflowId: string; uploadedById: string; content: string }) {
  const latest = await prisma.note.findFirst({
    where: { workflowId: params.workflowId },
    orderBy: { version: "desc" },
  });
  const version = (latest?.version ?? 0) + 1;
  const storageRef = `${params.workflowId}/notes/v${version}.txt`;

  await localFilesystemStorage.put(storageRef, params.content);

  return prisma.note.create({
    data: {
      workflowId: params.workflowId,
      version,
      storageRef,
      uploadedById: params.uploadedById,
    },
  });
}

export function findLatestNote(workflowId: string) {
  return prisma.note.findFirst({
    where: { workflowId },
    orderBy: { version: "desc" },
  });
}
