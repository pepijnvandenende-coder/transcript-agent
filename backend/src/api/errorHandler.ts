import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import {
  ConflictAlreadyResolvedError,
  ConflictNotFoundError,
  InvalidRetryInputError,
  InvalidTransitionError,
  MaxRetriesExceededError,
  NoOpenApprovalRequestError,
  NotAtCheckpointError,
  NotAtConflictReviewError,
} from "../domain/types";
import { PathTraversalError } from "../storage/localFilesystemStorage";

// Shared across every router mounted under /workflows -- centralizes the
// mapping from domain errors to HTTP status codes so each new router
// (uploads, validation, approval-request, conflicts) doesn't redeclare the
// same handler.
export function apiErrorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (
    err instanceof InvalidTransitionError ||
    err instanceof NotAtCheckpointError ||
    err instanceof MaxRetriesExceededError ||
    err instanceof NotAtConflictReviewError ||
    err instanceof ConflictAlreadyResolvedError
  ) {
    res.status(409).json({ error: err.message });
    return;
  }
  if (err instanceof NoOpenApprovalRequestError || err instanceof ConflictNotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof InvalidRetryInputError) {
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
