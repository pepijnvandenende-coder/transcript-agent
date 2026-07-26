import type { JobType, RetryMode } from "@prisma/client";
import { createQueuedJob } from "../persistence/repositories/jobRepository";

export function enqueue(params: {
  workflowId: string;
  jobType: JobType;
  inputRef?: string;
  retryOfAiOutputId?: string;
  retryMode?: RetryMode;
}) {
  return createQueuedJob(params);
}
