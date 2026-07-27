import { useEffect, useState } from "react";
import { getDrafts, reviewDraft, type Draft, type DraftPrecheck, type Workflow } from "../../api-client/client";
import { translateError } from "../../api-client/translateError";
import { BackOrCancel } from "../../components/BackOrCancel";

// Phase 15 item 2: showing only the failing items (as one summarizing
// sentence) made correct items read as "missing" whenever they happened to
// be bundled with something that failed. The backend now always returns a
// fixed five-item Dutch checklist (see ai/skills/draftQualityPrecheck.ts) --
// render every item with its own pass/fail marker instead of collapsing it
// into a single sentence. `checklist[].item` is already a presentable Dutch
// label for both outcomes (e.g. "Datum correct overgenomen" / "Datum
// ontbreekt"), so no separate translation is needed here.
function PrecheckChecklist({ precheck }: { precheck: DraftPrecheck }) {
  return (
    <ul>
      {precheck.checklist.map((entry) => (
        <li key={entry.item}>
          {entry.passed ? "✓" : "⚠"} {entry.item}
        </li>
      ))}
    </ul>
  );
}

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
      .catch((err) => setLoadError(translateError(err)));
  }, [workflow.id]);

  async function handleApprove() {
    if (!draft) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const updated = await reviewDraft(workflow.id, draft.version, { actorId: currentUserId, decision: "approve" });
      onUpdated(updated);
    } catch (err) {
      setSubmitError(translateError(err));
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
      setSubmitError(translateError(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError) return <p role="alert">{loadError}</p>;
  if (!draft) return <p>Concept wordt geladen...</p>;

  return (
    <div className="page">
      <div className="section">
        <h2>{draft.title}</h2>
        <p>Aanwezige deelnemers: {draft.attendees.length > 0 ? draft.attendees.join(", ") : "Niet vastgelegd"}</p>
        <p>Datum: {draft.date}</p>
        <p>Onderwerp: {draft.subject}</p>

        {draft.precheck && (
          <div className="section">
            <h3>Kwaliteitscontrole</h3>
            <PrecheckChecklist precheck={draft.precheck} />
          </div>
        )}

        {draft.sections.map((section) => (
          <section key={section.heading}>
            <h3>{section.heading}</h3>
            {section.content
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
              .map((line, index) => (
                <p key={index}>{line}</p>
              ))}
          </section>
        ))}
      </div>

      <div className="section">
        <div className="actions">
          <button type="button" className="button-primary" onClick={handleApprove} disabled={submitting}>
            Goedkeuren
          </button>
        </div>

        <div className="field">
          <label htmlFor="draft-feedback">Feedback voor wijzigingen</label>
          <textarea id="draft-feedback" value={feedback} onChange={(event) => setFeedback(event.target.value)} rows={4} />
        </div>
        <div className="actions">
          <button
            type="button"
            className="button-secondary"
            onClick={handleRequestChanges}
            disabled={submitting || feedback.trim().length === 0}
          >
            Wijzigingen aanvragen
          </button>
          <BackOrCancel mode="cancel" workflowId={workflow.id} currentUserId={currentUserId} onCancelled={onUpdated} />
        </div>

        {submitError && <p role="alert">{submitError}</p>}
      </div>
    </div>
  );
}
