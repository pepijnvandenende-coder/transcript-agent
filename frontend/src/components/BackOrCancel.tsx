import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { backToContext, cancelWorkflow, type Workflow } from "../api-client/client";
import { translateError } from "../api-client/translateError";

type BackOrCancelProps =
  | { mode: "back" }
  | { mode: "back-to-context"; workflowId: string; currentUserId: string; onUpdated: (workflow: Workflow) => void }
  | { mode: "cancel"; workflowId: string; currentUserId: string; onCancelled: (workflow: Workflow) => void };

// Shared "vorige stap"/"annuleren" control (Phase 11 feedback item 2).
//
// The FSM (see workflow/transitions.ts) has no backward transitions for
// AWAITING_REPORT_TYPE_SELECTION, DRAFT_PENDING_REVIEW, or COMPLETED -- only
// the universal `cancel` action, which ends the workflow (CANCELLED), not a
// step back. Rather than label that as "terug" (which it isn't), this
// component is honest about which behavior applies:
//   - mode="back": a real, local, no-backend-call navigation. Used only on
//     the very first data-entry screen (ContextStepScreen, since Phase 19),
//     where there is genuinely nothing to lose yet.
//   - mode="back-to-context": the Phase 19 `back_to_context` FSM edge (only
//     valid from CREATED) -- a genuine state transition, not a local
//     navigate(), so a page refresh on the transcript screen still shows the
//     right screen. Already-submitted context/notes are untouched by it.
//   - mode="cancel": the existing `cancel` FSM action, clearly labeled as
//     ending the workflow, with an inline confirmation step instead of a
//     blocking window.confirm dialog.
export function BackOrCancel(props: BackOrCancelProps) {
  const navigate = useNavigate();

  if (props.mode === "back") {
    return (
      <button type="button" className="button-secondary" onClick={() => navigate("/")}>
        Terug naar begin
      </button>
    );
  }

  if (props.mode === "back-to-context") {
    return (
      <BackToContextControl
        workflowId={props.workflowId}
        currentUserId={props.currentUserId}
        onUpdated={props.onUpdated}
      />
    );
  }

  return <CancelControl workflowId={props.workflowId} currentUserId={props.currentUserId} onCancelled={props.onCancelled} />;
}

function BackToContextControl({
  workflowId,
  currentUserId,
  onUpdated,
}: {
  workflowId: string;
  currentUserId: string;
  onUpdated: (workflow: Workflow) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setSubmitting(true);
    setError(null);
    try {
      const updated = await backToContext(workflowId, { actorId: currentUserId });
      onUpdated(updated);
    } catch (err) {
      setError(translateError(err));
      setSubmitting(false);
    }
  }

  return (
    <div>
      <button type="button" className="button-secondary" onClick={handleClick} disabled={submitting}>
        Terug naar aanvullende context
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

function CancelControl({
  workflowId,
  currentUserId,
  onCancelled,
}: {
  workflowId: string;
  currentUserId: string;
  onCancelled: (workflow: Workflow) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setCancelling(true);
    setError(null);
    try {
      const updated = await cancelWorkflow(workflowId, { actorId: currentUserId });
      onCancelled(updated);
    } catch (err) {
      setError(translateError(err));
      setCancelling(false);
    }
  }

  if (!confirming) {
    return (
      <button type="button" className="button-secondary" onClick={() => setConfirming(true)}>
        Workflow annuleren
      </button>
    );
  }

  return (
    <div>
      <p className="helper-text">Weet je zeker dat je deze workflow wilt annuleren? Dit stopt de workflow definitief.</p>
      <div className="actions">
        <button type="button" className="button-secondary" onClick={() => setConfirming(false)} disabled={cancelling}>
          Nee, doorgaan
        </button>
        <button type="button" className="button-danger" onClick={handleConfirm} disabled={cancelling}>
          Ja, annuleren
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
