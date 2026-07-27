import { useEffect, useState } from "react";
import { ApiError, finalReportDownloadUrl, getFinalReport, type FinalReport, type Workflow } from "../../api-client/client";
import { translateError } from "../../api-client/translateError";
import { BackOrCancel } from "../../components/BackOrCancel";

// Rendered by WorkflowPage for COMPLETED. Tolerates a momentary 404: reaching
// COMPLETED and writing the final_reports row are two separate steps inside
// jobs/runners/finalRendererRunner.ts (a known, pre-existing ordering race
// flagged back in the Phase 9 plan), not treated as a hard error here.
export function FinalDownloadScreen({
  workflow,
  currentUserId,
  onUpdated,
}: {
  workflow: Workflow;
  currentUserId: string;
  onUpdated: (workflow: Workflow) => void;
}) {
  const [finalReport, setFinalReport] = useState<FinalReport | null>(null);
  const [notReadyYet, setNotReadyYet] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  function load() {
    getFinalReport(workflow.id)
      .then((report) => {
        setFinalReport(report);
        setNotReadyYet(false);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) {
          setNotReadyYet(true);
          return;
        }
        setLoadError(translateError(err));
      });
  }

  useEffect(load, [workflow.id]);

  if (loadError) return <p role="alert">{loadError}</p>;

  if (notReadyYet || !finalReport) {
    return (
      <div className="page">
        <div className="section">
          <p>Eindrapport nog niet beschikbaar, probeer te vernieuwen.</p>
          <div className="actions">
            <button type="button" className="button-primary" onClick={load}>
              Vernieuwen
            </button>
            <BackOrCancel mode="cancel" workflowId={workflow.id} currentUserId={currentUserId} onCancelled={onUpdated} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="section">
        <h2>{finalReport.title}</h2>
        <p>Formaat: {finalReport.format}</p>
        <p>Aangemaakt: {finalReport.createdAt}</p>
        <div className="actions">
          <a href={finalReportDownloadUrl(workflow.id)} download className="button-primary">
            Download eindrapport
          </a>
          <BackOrCancel mode="cancel" workflowId={workflow.id} currentUserId={currentUserId} onCancelled={onUpdated} />
        </div>
      </div>
    </div>
  );
}
