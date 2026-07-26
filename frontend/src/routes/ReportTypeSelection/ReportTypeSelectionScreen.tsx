import { type FormEvent, useEffect, useState } from "react";
import {
  ApiError,
  getReportTypeSuggestion,
  selectReportType,
  type ReportTypeSuggestion,
  type Workflow,
} from "../../api-client/client";

// Rendered by WorkflowPage for AWAITING_REPORT_TYPE_SELECTION.
//
// There is no endpoint listing the full report_type_policies catalog (see
// the Phase 10-continuation plan's "Known limitation") -- only the
// advisor's own suggestion + runner-up. Those are offered as one-click
// buttons; anything else (including catalog entries the advisor didn't
// suggest) goes through the free-text fallback, which
// approval/reportTypeSelection.ts resolves the same way either path would.
export function ReportTypeSelectionScreen({
  workflow,
  currentUserId,
  onUpdated,
}: {
  workflow: Workflow;
  currentUserId: string;
  onUpdated: (workflow: Workflow) => void;
}) {
  const [suggestion, setSuggestion] = useState<ReportTypeSuggestion | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [freeform, setFreeform] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    getReportTypeSuggestion(workflow.id)
      .then(setSuggestion)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) {
          setSuggestion(null);
          return;
        }
        setLoadError(err instanceof Error ? err.message : "Onbekende fout");
      });
  }, [workflow.id]);

  async function choose(reportType: string) {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const updated = await selectReportType(workflow.id, { actorId: currentUserId, reportType });
      onUpdated(updated);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Onbekende fout");
    } finally {
      setSubmitting(false);
    }
  }

  function handleFreeformSubmit(event: FormEvent) {
    event.preventDefault();
    if (freeform.trim().length === 0) return;
    choose(freeform.trim());
  }

  if (loadError) return <p role="alert">{loadError}</p>;

  return (
    <div>
      {suggestion && (
        <div>
          <p>
            Voorgesteld verslagtype: <strong>{suggestion.suggestedType}</strong>
          </p>
          <p>{suggestion.rationale}</p>
          <button type="button" onClick={() => choose(suggestion.suggestedType)} disabled={submitting}>
            {suggestion.suggestedType} kiezen
          </button>
          {suggestion.runnerUp && (
            <button type="button" onClick={() => choose(suggestion.runnerUp!)} disabled={submitting}>
              {suggestion.runnerUp} kiezen
            </button>
          )}
        </div>
      )}

      <form onSubmit={handleFreeformSubmit}>
        <label>
          Ander verslagtype
          <input value={freeform} onChange={(event) => setFreeform(event.target.value)} />
        </label>
        <button type="submit" disabled={submitting || freeform.trim().length === 0}>
          Bevestigen
        </button>
      </form>

      {submitError && <p role="alert">{submitError}</p>}
    </div>
  );
}
