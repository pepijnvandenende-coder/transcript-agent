import { useEffect, useState } from "react";
import { getWorkflow, type Workflow, type WorkflowState } from "../api-client/client";

const POLL_INTERVAL_MS = 1500;
export const SLOW_HINT_AFTER_MS = 10000;

// Every PROCESSING state in the FSM (see backend/src/workflow/transitions.ts's
// PROCESSING_STATES) -- generalized from Phase 10's UploadPage, which only
// polled while VALIDATING_TRANSCRIPT. Every screen built on top of this hook
// gets the same "poll while the pipeline is working, stop once it reaches a
// checkpoint or terminal state" behavior for free.
const TRANSIENT_STATES = new Set<WorkflowState>([
  "VALIDATING_TRANSCRIPT",
  "MERGING",
  "DETECTING_CONFLICTS",
  "SUGGESTING_REPORT_TYPE",
  "GENERATING_DRAFT",
  "DRAFT_QUALITY_PRECHECK",
  "REVISING_DRAFT",
  "GENERATING_FINAL",
  "POST_PROCESSING",
]);

export function isTransientState(state: WorkflowState): boolean {
  return TRANSIENT_STATES.has(state);
}

// Loads a workflow by id and keeps it fresh: polls automatically while its
// currentState is transient, stopping the moment it changes to anything
// else. `setWorkflow` is exposed directly so a screen can apply the result
// of its *own* mutation (e.g. after approveDraft) immediately, without
// waiting for the next poll tick -- the same pattern UploadPage already used.
export function useWorkflow(id: string) {
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollingElapsedMs, setPollingElapsedMs] = useState(0);

  useEffect(() => {
    getWorkflow(id)
      .then(setWorkflow)
      .catch((err) => setError(err instanceof Error ? err.message : "Onbekende fout"));
  }, [id]);

  useEffect(() => {
    if (!workflow || !isTransientState(workflow.currentState)) return;

    const startedAt = Date.now();
    const interval = setInterval(() => {
      setPollingElapsedMs(Date.now() - startedAt);
      getWorkflow(id)
        .then((updated) => {
          if (updated.currentState !== workflow.currentState) {
            setPollingElapsedMs(0);
            setWorkflow(updated);
          }
        })
        .catch(() => {
          // Transient poll failure -- the next tick retries; not surfaced as
          // a hard error.
        });
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [id, workflow]);

  return { workflow, error, pollingElapsedMs, setWorkflow };
}
