import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { cancelWorkflow, type Workflow } from "../api-client/client";
import { translateError } from "../api-client/translateError";

type BackOrCancelProps =
  | { mode: "back" }
  | { mode: "cancel"; workflowId: string; currentUserId: string; onCancelled: (workflow: Workflow) => void };

// Shared "vorige stap"/"annuleren" control (Phase 11 feedback item 2).
//
// The FSM (see workflow/transitions.ts) has no backward transitions for
// AWAITING_REPORT_TYPE_SELECTION, DRAFT_PENDING_REVIEW, or COMPLETED -- only
// the universal `cancel` action, which ends the workflow (CANCELLED), not a
// step back. Rather than label that as "terug" (which it isn't), this
// component is honest about which behavior applies:
//   - mode="back": a real, local, no-backend-call navigation. Used only on
//     the very first data-entry screen, where there is genuinely nothing to
//     lose yet.
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

  return <CancelControl workflowId={props.workflowId} currentUserId={props.currentUserId} onCancelled={props.onCancelled} />;
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
