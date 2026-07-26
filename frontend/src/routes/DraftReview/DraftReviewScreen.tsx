import { useEffect, useState } from "react";
import { getDrafts, reviewDraft, type Draft, type Workflow } from "../../api-client/client";

// Rendered by WorkflowPage for DRAFT_PENDING_REVIEW. Covers both "Draft
// Review" and "Revision feedback" from the request -- per
// drafts.routes.ts's POST /workflows/:id/drafts/:version/review, approving
// and requesting changes are the same endpoint (`decision`), not two
// screens.
export function DraftReviewScreen({
  workflow,
  currentUserId,
  onUpdated,
}: {
  workflow: Workflow;
  currentUserId: string;
  onUpdated: (workflow: Workflow) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    getDrafts(workflow.id)
      .then((drafts) => setDraft(drafts[drafts.length - 1] ?? null))
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Onbekende fout"));
  }, [workflow.id]);

  async function handleApprove() {
    if (!draft) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const updated = await reviewDraft(workflow.id, draft.version, { actorId: currentUserId, decision: "approve" });
      onUpdated(updated);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Onbekende fout");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRequestChanges() {
    if (!draft || feedback.trim().length === 0) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const updated = await reviewDraft(workflow.id, draft.version, {
        actorId: currentUserId,
        decision: "request_changes",
        feedback: feedback.trim(),
      });
      onUpdated(updated);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Onbekende fout");
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError) return <p role="alert">{loadError}</p>;
  if (!draft) return <p>Concept wordt geladen...</p>;

  return (
    <div>
      <h2>{draft.title}</h2>
      <p>Aanwezige deelnemers: {draft.attendees.length > 0 ? draft.attendees.join(", ") : "Niet vastgelegd"}</p>
      <p>Datum: {draft.date}</p>
      <p>Onderwerp: {draft.subject}</p>

      {draft.precheck && (
        <div>
          <p>Kwaliteitscontrole: {Math.round(draft.precheck.overallScore * 100)}%</p>
          {draft.precheck.blockingIssues.length > 0 && (
            <ul>
              {draft.precheck.blockingIssues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
          <p>{draft.precheck.recommendation}</p>
        </div>
      )}

      {draft.sections.map((section) => (
        <section key={section.heading}>
          <h3>{section.heading}</h3>
          <p>{section.content}</p>
        </section>
      ))}

      <button type="button" onClick={handleApprove} disabled={submitting}>
        Goedkeuren
      </button>

      <div>
        <label>
          Feedback voor wijzigingen
          <textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} rows={4} />
        </label>
        <button type="button" onClick={handleRequestChanges} disabled={submitting || feedback.trim().length === 0}>
          Wijzigingen aanvragen
        </button>
      </div>

      {submitError && <p role="alert">{submitError}</p>}
    </div>
  );
}
