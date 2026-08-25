import { type FormEvent, useState } from "react";
import { submitForValidation, uploadTranscript, type Workflow } from "../../api-client/client";
import { translateError } from "../../api-client/translateError";
import { BackOrCancel } from "../../components/BackOrCancel";
import { FileOrPasteField } from "../../components/FileOrPasteField";

// Rendered by WorkflowPage for CREATED/TRANSCRIPT_UPLOADED/VALIDATING_TRANSCRIPT.
// Purely presentational now -- WorkflowPage owns fetching/polling (via
// state/useWorkflow.ts) and the generic "still processing" hint, which now
// applies to every transient state, not just this screen's own.
//
// Phase 19: notes and the catalog-driven context types (PvA, normenkader,
// vragenlijst, ...) moved off this screen onto their own step, shown before
// this one -- see routes/Context/ContextStepScreen.tsx (CONTEXT_INPUT, only
// reachable state before CREATED). This screen is transcript-only now.
export function UploadScreen({
  workflow,
  currentUserId,
  onUpdated,
}: {
  workflow: Workflow;
  currentUserId: string;
  onUpdated: (workflow: Workflow) => void;
}) {
  const [transcript, setTranscript] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function handleUploadAndSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    try {
      await uploadTranscript(workflow.id, { uploadedById: currentUserId, content: transcript });
      const updated = await submitForValidation(workflow.id, { actorId: currentUserId });
      onUpdated(updated);
    } catch (err) {
      setSubmitError(translateError(err));
    } finally {
      setSubmitting(false);
    }
  }

  // Resumption case: transcript was already uploaded (e.g. the browser was
  // closed before submit-for-validation completed) -- no need to re-upload.
  async function handleSubmitOnly() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const updated = await submitForValidation(workflow.id, { actorId: currentUserId });
      onUpdated(updated);
    } catch (err) {
      setSubmitError(translateError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      {workflow.currentState === "CREATED" && (
        <form onSubmit={handleUploadAndSubmit} className="section">
          <FileOrPasteField
            id="upload-transcript"
            label="Transcript"
            instructions="Upload hier het transcript van het gesprek. Dit is de primaire bron voor het gespreksverslag."
            value={transcript}
            onChange={setTranscript}
            required
          />

          <div className="actions">
            <button type="submit" className="button-primary" disabled={submitting || transcript.trim().length === 0}>
              Uploaden en indienen voor validatie
            </button>
            <BackOrCancel mode="back-to-context" workflowId={workflow.id} currentUserId={currentUserId} onUpdated={onUpdated} />
          </div>
        </form>
      )}

      {workflow.currentState === "TRANSCRIPT_UPLOADED" && (
        <div className="section">
          <p>Transcript is al geüpload.</p>
          <div className="actions">
            <button type="button" className="button-primary" onClick={handleSubmitOnly} disabled={submitting}>
              Indienen voor validatie
            </button>
            <BackOrCancel mode="back" />
          </div>
        </div>
      )}

      {workflow.currentState === "VALIDATING_TRANSCRIPT" && (
        <div className="actions">
          <BackOrCancel mode="back" />
        </div>
      )}

      {submitError && <p role="alert">{submitError}</p>}
    </>
  );
}
