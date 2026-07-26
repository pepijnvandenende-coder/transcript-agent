import { prisma } from "../prismaClient";

// One row per request_draft_changes submission -- see approval/draftReview.ts's
// requestDraftChanges() for the single write path. Never mutated.
export function createReviewFeedback(params: {
  workflowId: string;
  draftId: string;
  feedback: string;
  createdById: string;
}) {
  return prisma.reviewFeedback.create({
    data: {
      workflowId: params.workflowId,
      draftId: params.draftId,
      feedback: params.feedback,
      createdById: params.createdById,
    },
  });
}

// Unused until Phase 8 (DraftReviser reads the feedback for the draft it's
// revising), added now so the repository shape doesn't need to change
// alongside that phase.
export function findFeedbackForDraft(draftId: string) {
  return prisma.reviewFeedback.findMany({
    where: { draftId },
    orderBy: { createdAt: "asc" },
  });
}
