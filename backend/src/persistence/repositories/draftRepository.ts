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
  actionsPresent: boolean;
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
      actionsPresent: params.actionsPresent,
    },
  });
}

// Read by draftQualityPrecheckRunner.ts (Phase 7) and approval/draftReview.ts
// -- the checkpoint always acts on whichever draft is currently latest.
export function findLatestDraft(workflowId: string) {
  return prisma.draft.findFirst({
    where: { workflowId },
    orderBy: { version: "desc" },
  });
}

// Phase 7: GET /workflows/:id/drafts -- full version history for this workflow.
export function findAllDraftsForWorkflow(workflowId: string) {
  return prisma.draft.findMany({
    where: { workflowId },
    orderBy: { version: "asc" },
  });
}

// Phase 7: GET /workflows/:id/drafts/:version, and used by
// approval/draftReview.ts to confirm a review action targets the current
// latest version.
export function findDraftByVersion(workflowId: string, version: number) {
  return prisma.draft.findUnique({
    where: { workflowId_version: { workflowId, version } },
  });
}
