import type { Prisma } from "@prisma/client";
import { prisma } from "../prismaClient";

// Drafts are versioned and insert-only, same rule as Merge/ReportTypeSuggestion
// -- see jobs/runners/draftGenerationRunner.ts for the single write path.
export async function createDraftVersion(params: {
  workflowId: string;
  aiOutputId: string;
  reportType: string;
  title: string;
  attendees: Prisma.InputJsonValue;
  date: string;
  subject: string;
  sections: Prisma.InputJsonValue;
  coverage?: number;
}) {
  const latest = await prisma.draft.findFirst({
    where: { workflowId: params.workflowId },
    orderBy: { version: "desc" },
  });
  const version = (latest?.version ?? 0) + 1;

  return prisma.draft.create({
    data: {
      workflowId: params.workflowId,
      version,
      aiOutputId: params.aiOutputId,
      reportType: params.reportType,
      title: params.title,
      attendees: params.attendees,
      date: params.date,
      subject: params.subject,
      sections: params.sections,
      coverage: params.coverage,
    },
  });
}

// Unused until Phase 7 (DraftQualityPrecheck reads the draft), added now so
// the repository shape doesn't need to change alongside that phase.
export function findLatestDraft(workflowId: string) {
  return prisma.draft.findFirst({
    where: { workflowId },
    orderBy: { version: "desc" },
  });
}
