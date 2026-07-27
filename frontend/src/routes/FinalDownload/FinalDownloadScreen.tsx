import { useEffect, useState } from "react";
import { ApiError, finalReportDownloadUrl, getFinalReport, type FinalReport, type Workflow } from "../../api-client/client";
import { translateError } from "../../api-client/translateError";

// Rendered by WorkflowPage for COMPLETED. Tolerates a momentary 404: reaching
// COMPLETED and writing the final_reports row are two separate steps inside
// jobs/runners/finalRendererRunner.ts (a known, pre-existing ordering race
// flagged back in the Phase 9 plan), not treated as a hard error here.
//
// Phase 16: no cancel control on this screen (either branch) -- COMPLETED is
// a terminal FSM state (workflow/transitions.ts's CANCEL_TRANSITIONS only
// covers non-terminal states), so "Workflow annuleren" here was already a
// dead control that would fail with an FSM error if clicked. The operator
// doesn't need file-format/timestamp details either -- just the title,
// status (shown by the shared Layout, not duplicated here), and one primary
// download action.
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
      <div className="section">
        <p>Eindrapport nog niet beschikbaar, probeer te vernieuwen.</p>
        <div className="actions">
          <button type="button" className="button-primary" onClick={load}>
            Vernieuwen
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="section">
      <h2>{finalReport.title}</h2>
      <div className="actions">
        <a href={finalReportDownloadUrl(workflow.id)} download className="button-primary">
          Download gespreksverslag
        </a>
      </div>
    </div>
  );
}
