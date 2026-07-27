import { useEffect, useState } from "react";
import {
  ApiError,
  getReportTypePolicies,
  getReportTypeSuggestion,
  selectReportType,
  type ReportTypePolicy,
  type ReportTypeSuggestion,
  type Workflow,
} from "../../api-client/client";
import { translateError } from "../../api-client/translateError";
import { BackOrCancel } from "../../components/BackOrCancel";

// Resolves a stored suggestion value to its Dutch display name. Phase 13:
// ReportTypeAdvisor's structured output now returns a catalog *key* (e.g.
// "thematic"), not a display name -- keys are what selectReportType()
// actually needs, but a raw key must never reach the screen unresolved (the
// codebase's "no English/internal text visible to operators" rule, Phase 11
// feedback item 4). Falls back to the raw value if it doesn't match any
// policy, so it degrades gracefully rather than showing nothing.
function displayNameFor(key: string, policies: ReportTypePolicy[]): string {
  return policies.find((policy) => policy.key === key)?.displayName ?? key;
}

// Rendered by WorkflowPage for AWAITING_REPORT_TYPE_SELECTION.
//
// Phase 13 feedback: an operator must always be able to deviate from the
// AI's suggestion -- this reverses Phase 11 feedback item 5's "agree or
// cancel only" restriction (see this file's git history). The backend never
// actually enforced that restriction (POST .../report-type already accepted
// any active catalog entry); only the frontend did.
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
  const [policies, setPolicies] = useState<ReportTypePolicy[]>([]);
  const [selectedType, setSelectedType] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    getReportTypePolicies()
      .then(setPolicies)
      .catch((err) => setLoadError(translateError(err)));

    getReportTypeSuggestion(workflow.id)
      .then((result) => {
        setSuggestion(result);
        setSelectedType(result.suggestedType);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) {
          setSuggestion(null);
          return;
        }
        setLoadError(translateError(err));
      });
  }, [workflow.id]);

  async function handleConfirm() {
    if (!selectedType) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const updated = await selectReportType(workflow.id, { actorId: currentUserId, reportType: selectedType });
      onUpdated(updated);
    } catch (err) {
      setSubmitError(translateError(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError) return <p role="alert">{loadError}</p>;

  return (
    <div className="page">
      <div className="section">
        {suggestion ? (
          <>
            <h2>Voorgesteld verslagtype: {displayNameFor(suggestion.suggestedType, policies)}</h2>
            <p>{suggestion.rationale}</p>

            <fieldset className="field">
              <legend>Kies het verslagtype</legend>
              {policies.map((policy) => (
                <label key={policy.key} style={{ display: "block" }}>
                  <input
                    type="radio"
                    name="report-type"
                    value={policy.key}
                    checked={selectedType === policy.key}
                    onChange={() => setSelectedType(policy.key)}
                  />{" "}
                  {policy.displayName}
                  {policy.key === suggestion.suggestedType && (
                    <span className="helper-text"> (voorgesteld door de AI)</span>
                  )}
                </label>
              ))}
            </fieldset>

            <div className="actions">
              <button type="button" className="button-primary" onClick={handleConfirm} disabled={submitting || !selectedType}>
                Bevestigen en doorgaan
              </button>
              <BackOrCancel mode="cancel" workflowId={workflow.id} currentUserId={currentUserId} onCancelled={onUpdated} />
            </div>
          </>
        ) : (
          <>
            <p className="helper-text">Er wordt nog een verslagtype voorgesteld. Dit scherm ververst automatisch.</p>
            <div className="actions">
              <BackOrCancel mode="cancel" workflowId={workflow.id} currentUserId={currentUserId} onCancelled={onUpdated} />
            </div>
          </>
        )}
        {submitError && <p role="alert">{submitError}</p>}
      </div>
    </div>
  );
}
