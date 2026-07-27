import { useEffect, useState } from "react";
import { getLatestJob, type WorkflowJob } from "../api-client/client";

const STATUS_LABELS: Record<WorkflowJob["status"], string> = {
  QUEUED: "In wachtrij -- wacht tot de achtergrondverwerking (worker) beschikbaar is.",
  RUNNING: "Wordt op dit moment uitgevoerd door de AI...",
  SUCCEEDED: "Voltooid.",
  FAILED: "Mislukt.",
};

// Shown alongside StatusBadge for every PROCESSING (transient) state, so an
// operator understands *why* the workflow is waiting -- queued behind other
// work vs. actively running -- rather than only a generic "bezig..." badge.
// Phase 13 (real usage-test feedback: "voeg waar mogelijk statusinformatie
// toe zodat een gebruiker begrijpt waarom een workflow wacht"). Polls
// independently of WorkflowPage's own poll (state/useWorkflow.ts only
// re-renders on a *state* change, not while a job progresses through
// QUEUED -> RUNNING within the same state).
export function JobStatusHint({ workflowId }: { workflowId: string }) {
  const [job, setJob] = useState<WorkflowJob | null>(null);

  useEffect(() => {
    let cancelled = false;
    function poll() {
      getLatestJob(workflowId)
        .then((result) => {
          if (!cancelled) setJob(result);
        })
        .catch(() => {
          // No job yet, or a transient fetch failure -- not worth surfacing
          // here; the StatusBadge already shows a generic status.
        });
    }
    poll();
    const interval = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [workflowId]);

  if (!job || job.status === "SUCCEEDED") return null;
  return <p className="helper-text">{STATUS_LABELS[job.status]}</p>;
}
