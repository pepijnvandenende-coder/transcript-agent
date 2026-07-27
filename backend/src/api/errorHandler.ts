import { Prisma } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import {
  ConflictAlreadyResolvedError,
  ConflictNotFoundError,
  DraftVersionMismatchError,
  InvalidRetryInputError,
  InvalidTransitionError,
  MaxRetriesExceededError,
  NoFailedJobFoundError,
  NoOpenApprovalRequestError,
  NotAtCheckpointError,
  NotAtConflictReviewError,
  NotAtDraftReviewError,
  NotAtFailedStateError,
  NotAwaitingReportTypeSelectionError,
  UnknownReportTypeError,
} from "../domain/types";
import { PathTraversalError } from "../storage/localFilesystemStorage";

// Shared across every router mounted under /workflows -- centralizes the
// mapping from domain errors to HTTP status codes so each new router
// (uploads, validation, approval-request, conflicts, report-type) doesn't
// redeclare the same handler.
export function apiErrorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (
    err instanceof InvalidTransitionError ||
    err instanceof NotAtCheckpointError ||
    err instanceof MaxRetriesExceededError ||
    err instanceof NotAtConflictReviewError ||
    err instanceof ConflictAlreadyResolvedError ||
    err instanceof NotAwaitingReportTypeSelectionError ||
    err instanceof NotAtDraftReviewError ||
    err instanceof DraftVersionMismatchError ||
    err instanceof NotAtFailedStateError
  ) {
    res.status(409).json({ error: err.message });
    return;
  }
  if (
    err instanceof NoOpenApprovalRequestError ||
    err instanceof ConflictNotFoundError ||
    err instanceof NoFailedJobFoundError
  ) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof InvalidRetryInputError || err instanceof UnknownReportTypeError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: "Invalid request body", details: err.issues });
    return;
  }
  if (err instanceof PathTraversalError) {
    res.status(400).json({ error: "Invalid storage reference" });
    return;
  }
  // Phase 16 item 7: a localStorage-remembered user id that no longer exists
  // server-side (e.g. test data was cleaned up) used to surface as a raw
  // "workflows_created_by_fkey" 500 the first time any write referenced it
  // (creating a workflow, uploading a transcript, leaving feedback, ...).
  // Every such write goes through a foreign key to users.id, so catching
  // Prisma's P2003 here -- rather than special-casing each route -- covers
  // all of them at once with a machine-readable code the frontend can act on
  // (see frontend/src/api-client/client.ts's apiFetch).
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
    res.status(400).json({
      error: "USER_SESSION_INVALID",
      message: "De gebruiker bestaat niet meer. Maak opnieuw een sessie aan.",
    });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
}
