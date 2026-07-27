import { useEffect, useState } from "react";
import { getLatestJob, retryFailedJob, type Workflow, type WorkflowJob } from "../../api-client/client";
import { translateError, translateJobError } from "../../api-client/translateError";

// Rendered by WorkflowPage for FAILED. Phase 13: closes a real gap found
// during eis 5's investigation -- backend/src/jobs/worker.ts's failJob()
// fix means a failed job now actually moves the workflow to FAILED (it
// previously never did, leaving the workflow stuck at its PROCESSING state
// forever with no visible error), and workflows.routes.ts's new
// retry-failed-job route exposes the `retry_failed_job.<state>` FSM edge
// that has existed since Phase 1 but had no route until now -- so FAILED is
// no longer a dead end.
export function FailedScreen({
  workflow,
  currentUserId,
  onUpdated,
}: {
  workflow: Workflow;
  currentUserId: string;
  onUpdated: (workflow: Workflow) => void;
}) {
  const [job, setJob] = useState<WorkflowJob | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  useEffect(() => {
    getLatestJob(workflow.id)
      .then(setJob)
      .catch((err) => setLoadError(translateError(err)));
  }, [workflow.id]);

  async function handleRetry() {
    setRetrying(true);
    setRetryError(null);
    try {
      const updated = await retryFailedJob(workflow.id, { actorId: currentUserId });
      onUpdated(updated);
    } catch (err) {
      setRetryError(translateError(err));
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="section">
      <h2>Workflow mislukt</h2>
      <p>Er is een fout opgetreden tijdens een automatische stap van deze workflow.</p>
      {job?.error && <p className="helper-text">Oorzaak: {translateJobError(job.error)}</p>}
      {loadError && <p role="alert">{loadError}</p>}

      <div className="actions">
        <button type="button" className="button-primary" onClick={handleRetry} disabled={retrying}>
          Opnieuw proberen
        </button>
      </div>
      {retryError && <p role="alert">{retryError}</p>}
    </div>
  );
}
