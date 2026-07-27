import { useEffect, useState } from "react";
import { explainConflict, getConflicts, restartUpload, type Conflict, type Workflow } from "../../api-client/client";
import { translateError } from "../../api-client/translateError";

// Rendered by WorkflowPage for CONFLICTS_PENDING_REVIEW. Per
// approval/conflictResolution.ts's explainConflict(): the workflow only
// advances (to MERGING) once every OPEN conflict has been explained -- until
// then its `workflow` field comes back null and this screen just re-fetches
// the (now-shorter) open list.
export function ConflictReviewScreen({
  workflow,
  currentUserId,
  onUpdated,
}: {
  workflow: Workflow;
  currentUserId: string;
  onUpdated: (workflow: Workflow) => void;
}) {
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [explanations, setExplanations] = useState<Record<string, string>>({});
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  function refresh() {
    getConflicts(workflow.id)
      .then(setConflicts)
      .catch((err) => setLoadError(translateError(err)));
  }

  useEffect(refresh, [workflow.id]);

  async function handleExplain(conflictId: string) {
    const explanation = explanations[conflictId]?.trim() ?? "";
    if (!explanation) return;
    setSubmittingId(conflictId);
    setActionError(null);
    try {
      const result = await explainConflict(workflow.id, conflictId, { actorId: currentUserId, explanation });
      if (result.workflow) {
        onUpdated(result.workflow);
      } else {
        refresh();
      }
    } catch (err) {
      setActionError(translateError(err));
    } finally {
      setSubmittingId(null);
    }
  }

  async function handleRestartUpload() {
    setRestarting(true);
    setActionError(null);
    try {
      const updated = await restartUpload(workflow.id, { actorId: currentUserId });
      onUpdated(updated);
    } catch (err) {
      setActionError(translateError(err));
    } finally {
      setRestarting(false);
    }
  }

  if (loadError) return <p role="alert">{loadError}</p>;
  if (!conflicts) return <p>Conflicten worden geladen...</p>;

  const open = conflicts.filter((c) => c.status === "OPEN");
  const resolved = conflicts.filter((c) => c.status === "RESOLVED");

  return (
    <div className="section">
      <h2>Openstaande conflicten</h2>
        {open.length === 0 && <p>Geen openstaande conflicten.</p>}
        {open.map((conflict) => (
          <div key={conflict.id} className="section">
            <p>{conflict.description}</p>
            {(conflict.sourceA || conflict.sourceB) && (
              <div className="conflict-sources">
                <div>
                  <strong>Bron A</strong>
                  <p>{conflict.sourceA ?? "-"}</p>
                </div>
                <div>
                  <strong>Bron B</strong>
                  <p>{conflict.sourceB ?? "-"}</p>
                </div>
              </div>
            )}
            <div className="field">
              <label htmlFor={`explanation-${conflict.id}`}>Toelichting</label>
              <textarea
                id={`explanation-${conflict.id}`}
                value={explanations[conflict.id] ?? ""}
                onChange={(event) => setExplanations((prev) => ({ ...prev, [conflict.id]: event.target.value }))}
                rows={3}
              />
            </div>
            <div className="actions">
              <button
                type="button"
                className="button-primary"
                onClick={() => handleExplain(conflict.id)}
                disabled={submittingId === conflict.id || !(explanations[conflict.id]?.trim())}
              >
                Verklaren
              </button>
            </div>
          </div>
        ))}

        {resolved.length > 0 && (
          <>
            <h3>Opgelost</h3>
            {resolved.map((conflict) => (
              <div key={conflict.id}>
                <p>{conflict.description}</p>
                <p>
                  <em>Verklaring: {conflict.resolution}</em>
                </p>
              </div>
            ))}
          </>
        )}

        {actionError && <p role="alert">{actionError}</p>}

        <div className="actions">
          <button type="button" className="button-secondary" onClick={handleRestartUpload} disabled={restarting}>
            Upload opnieuw starten
          </button>
        </div>
    </div>
  );
}
