import { useEffect, useState } from "react";
import {
  confirmApprovalRequestAction,
  editRetryApprovalRequestAction,
  getApprovalRequest,
  type ApprovalRequest,
  type Workflow,
} from "../../api-client/client";
import { translateError } from "../../api-client/translateError";
import { BackOrCancel } from "../../components/BackOrCancel";

// Which input(s) a given origin skill's checkpoint can be edit-retried with --
// mirrors backend/src/approval/gateway.ts's SKILL_ROUTING[skill].inputs
// exactly (TranscriptQualityChecker: transcript only, Merger: both,
// ConflictDetector: neither -- editRetryApprovalRequest() rejects any input
// for that skill with InvalidRetryInputError). Hard-coded here rather than
// derived from the API response because it's a fixed, small mapping and the
// alternative (exposing `routing.inputs` over HTTP) would be new backend
// surface for no benefit.
const EDITABLE_INPUTS: Record<string, Array<"transcript" | "notes">> = {
  TranscriptQualityChecker: ["transcript"],
  Merger: ["transcript", "notes"],
  ConflictDetector: [],
};

const SKILL_EXPLANATIONS: Record<string, string> = {
  TranscriptQualityChecker: "of het transcript geschikt is om mee door te gaan",
  Merger: "over het automatisch samenvoegen van transcript en notities",
  ConflictDetector: "of er tegenstrijdigheden in het samengevoegde materiaal zitten",
};

function explanationFor(aiOutput: ApprovalRequest["aiOutput"]): string {
  if (aiOutput.validationStatus === "INVALID") {
    return "De AI kon voor deze stap geen bruikbaar resultaat opleveren. Een mens moet daarom beoordelen hoe de workflow verder moet.";
  }
  const subject = SKILL_EXPLANATIONS[aiOutput.skillName] ?? "over het resultaat van deze stap";
  return `De AI is onvoldoende zeker ${subject}. Een mens moet dit daarom beoordelen voordat de workflow verdergaat.`;
}

function confidenceText(aiOutput: ApprovalRequest["aiOutput"]): string {
  if (aiOutput.validationStatus === "INVALID" || aiOutput.confidenceScore === null) {
    return "De AI-uitvoer kon niet op zekerheid worden beoordeeld -- het formaat klopte niet.";
  }
  return `Zekerheid van de AI: ${Math.round(aiOutput.confidenceScore * 100)}%.`;
}

// Rendered by WorkflowPage for PENDING_HUMAN_CONFIRMATION -- the generic
// human-in-the-loop checkpoint every AUTO_IF_ABOVE skill (transcript
// validation, merge, conflict detection) can open. Exactly three choices,
// per the Phase 12 plan: confirm-and-continue, edit-and-retry (only when the
// origin skill has editable input), or cancel -- deliberately no
// retry-without-changes button, even though the backend supports it.
export function ConfirmLowConfidenceScreen({
  workflow,
  currentUserId,
  onUpdated,
}: {
  workflow: Workflow;
  currentUserId: string;
  onUpdated: (workflow: Workflow) => void;
}) {
  const [approvalRequest, setApprovalRequest] = useState<ApprovalRequest | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [transcriptContent, setTranscriptContent] = useState("");
  const [notesContent, setNotesContent] = useState("");
  const [confirmSubmitting, setConfirmSubmitting] = useState(false);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    getApprovalRequest(workflow.id)
      .then(setApprovalRequest)
      .catch((err) => setLoadError(translateError(err)));
  }, [workflow.id]);

  async function handleConfirm() {
    setConfirmSubmitting(true);
    setSubmitError(null);
    try {
      const updated = await confirmApprovalRequestAction(workflow.id, { actorId: currentUserId });
      onUpdated(updated);
    } catch (err) {
      setSubmitError(translateError(err));
    } finally {
      setConfirmSubmitting(false);
    }
  }

  async function handleEditRetry() {
    setEditSubmitting(true);
    setSubmitError(null);
    try {
      const updated = await editRetryApprovalRequestAction(workflow.id, {
        actorId: currentUserId,
        transcriptContent: transcriptContent.trim() ? transcriptContent.trim() : undefined,
        notesContent: notesContent.trim() ? notesContent.trim() : undefined,
      });
      onUpdated(updated);
    } catch (err) {
      setSubmitError(translateError(err));
    } finally {
      setEditSubmitting(false);
    }
  }

  if (loadError) return <p role="alert">{loadError}</p>;
  if (!approvalRequest) return <p>Gegevens worden geladen...</p>;

  const { aiOutput } = approvalRequest;
  const editableInputs = EDITABLE_INPUTS[aiOutput.skillName] ?? [];
  const retryBudgetSpent = approvalRequest.attemptCount >= approvalRequest.maxRetries;
  const canEditRetry = editableInputs.length > 0 && !retryBudgetSpent;
  const editRetryDisabled =
    editSubmitting || (transcriptContent.trim().length === 0 && notesContent.trim().length === 0);

  return (
    <div className="page">
      <div className="section">
        <h2>Bevestiging nodig</h2>
        <p>{explanationFor(aiOutput)}</p>
        <p>{confidenceText(aiOutput)}</p>
        <p className="helper-text">
          Poging {approvalRequest.attemptCount} van maximaal {approvalRequest.maxRetries}.
        </p>
      </div>

      <div className="section">
        <div className="actions">
          <button type="button" className="button-primary" onClick={handleConfirm} disabled={confirmSubmitting}>
            Bevestigen en doorgaan
          </button>
        </div>
      </div>

      <div className="section">
        {canEditRetry ? (
          <>
            <h3>Terug en aanpassen</h3>
            {editableInputs.includes("transcript") && (
              <div className="field">
                <label htmlFor="edit-transcript">Aangepast transcript</label>
                <textarea
                  id="edit-transcript"
                  value={transcriptContent}
                  onChange={(event) => setTranscriptContent(event.target.value)}
                  rows={6}
                />
              </div>
            )}
            {editableInputs.includes("notes") && (
              <div className="field">
                <label htmlFor="edit-notes">Aangepaste notities</label>
                <textarea
                  id="edit-notes"
                  value={notesContent}
                  onChange={(event) => setNotesContent(event.target.value)}
                  rows={6}
                />
              </div>
            )}
            <div className="actions">
              <button type="button" className="button-secondary" onClick={handleEditRetry} disabled={editRetryDisabled}>
                Aangepaste versie opnieuw laten controleren
              </button>
            </div>
          </>
        ) : (
          <p className="helper-text">
            {retryBudgetSpent
              ? "Je hebt het maximaal aantal pogingen bereikt voor deze stap -- kies bevestigen of annuleer de workflow."
              : "Voor deze stap is er niets om aan te passen -- kies bevestigen of annuleer de workflow."}
          </p>
        )}
      </div>

      <div className="section">
        <div className="actions">
          <BackOrCancel mode="cancel" workflowId={workflow.id} currentUserId={currentUserId} onCancelled={onUpdated} />
        </div>
      </div>

      {submitError && <p role="alert">{submitError}</p>}
    </div>
  );
}
