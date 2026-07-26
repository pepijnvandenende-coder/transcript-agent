import { type FormEvent, useState } from "react";
import { submitForValidation, uploadNotes, uploadTranscript, type Workflow } from "../../api-client/client";

// Rendered by WorkflowPage for CREATED/TRANSCRIPT_UPLOADED/VALIDATING_TRANSCRIPT.
// Purely presentational now -- WorkflowPage owns fetching/polling (via
// state/useWorkflow.ts) and the generic "still processing" hint, which now
// applies to every transient state, not just this screen's own.
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
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function handleUploadAndSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    try {
      await uploadTranscript(workflow.id, { uploadedById: currentUserId, content: transcript });
      if (notes.trim().length > 0) {
        await uploadNotes(workflow.id, { uploadedById: currentUserId, content: notes });
      }
      const updated = await submitForValidation(workflow.id, { actorId: currentUserId });
      onUpdated(updated);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Onbekende fout");
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
      setSubmitError(err instanceof Error ? err.message : "Onbekende fout");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      {workflow.currentState === "CREATED" && (
        <form onSubmit={handleUploadAndSubmit}>
          <label>
            Transcript
            <textarea
              value={transcript}
              onChange={(event) => setTranscript(event.target.value)}
              required
              rows={10}
            />
          </label>
          <label>
            Notities (optioneel)
            <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={5} />
          </label>
          <button type="submit" disabled={submitting || transcript.trim().length === 0}>
            Uploaden en indienen voor validatie
          </button>
        </form>
      )}

      {workflow.currentState === "TRANSCRIPT_UPLOADED" && (
        <div>
          <p>Transcript is al geüpload.</p>
          <button type="button" onClick={handleSubmitOnly} disabled={submitting}>
            Indienen voor validatie
          </button>
        </div>
      )}

      {submitError && <p role="alert">{submitError}</p>}
    </div>
  );
}
