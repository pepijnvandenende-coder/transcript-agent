import { prisma } from "../prismaClient";
import { localFilesystemStorage } from "../../storage/localFilesystemStorage";

// Transcripts are insert-only and versioned (see prisma/schema.prisma) -- a
// re-upload always creates version = latest + 1, never overwrites an
// existing row. Version computation, the storage write, and the DB row all
// happen together here so there is exactly one place that decides the next
// version number and the storage_ref that names it.
export async function createTranscriptVersion(params: {
  workflowId: string;
  uploadedById: string;
  content: string;
}) {
  const latest = await prisma.transcript.findFirst({
    where: { workflowId: params.workflowId },
    orderBy: { version: "desc" },
  });
  const version = (latest?.version ?? 0) + 1;
  const storageRef = `${params.workflowId}/transcripts/v${version}.txt`;

  await localFilesystemStorage.put(storageRef, params.content);

  return prisma.transcript.create({
    data: {
      workflowId: params.workflowId,
      version,
      storageRef,
      uploadedById: params.uploadedById,
    },
  });
}

export function findLatestTranscript(workflowId: string) {
  return prisma.transcript.findFirst({
    where: { workflowId },
    orderBy: { version: "desc" },
  });
}

export function findTranscriptById(id: string) {
  return prisma.transcript.findUnique({ where: { id } });
}
