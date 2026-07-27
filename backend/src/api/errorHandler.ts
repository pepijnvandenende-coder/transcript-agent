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
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
}
