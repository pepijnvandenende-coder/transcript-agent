import { useEffect, useState } from "react";
import { explainConflict, getConflicts, restartUpload, type Conflict, type Workflow } from "../../api-client/client";

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
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Onbekende fout"));
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
      setActionError(err instanceof Error ? err.message : "Onbekende fout");
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
      setActionError(err instanceof Error ? err.message : "Onbekende fout");
    } finally {
      setRestarting(false);
    }
  }

  if (loadError) return <p role="alert">{loadError}</p>;
  if (!conflicts) return <p>Conflicten worden geladen...</p>;

  const open = conflicts.filter((c) => c.status === "OPEN");
  const resolved = conflicts.filter((c) => c.status === "RESOLVED");

  return (
    <div>
      <h2>Openstaande conflicten</h2>
      {open.length === 0 && <p>Geen openstaande conflicten.</p>}
      {open.map((conflict) => (
        <div key={conflict.id}>
          <p>{conflict.description}</p>
          {(conflict.sourceA || conflict.sourceB) && (
            <div style={{ display: "flex", gap: "1rem" }}>
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
          <label>
            Toelichting
            <textarea
              value={explanations[conflict.id] ?? ""}
              onChange={(event) => setExplanations((prev) => ({ ...prev, [conflict.id]: event.target.value }))}
              rows={3}
            />
          </label>
          <button
            type="button"
            onClick={() => handleExplain(conflict.id)}
            disabled={submittingId === conflict.id || !(explanations[conflict.id]?.trim())}
          >
            Verklaren
          </button>
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

      <p>
        <button type="button" onClick={handleRestartUpload} disabled={restarting}>
          Upload opnieuw starten
        </button>
      </p>
    </div>
  );
}
