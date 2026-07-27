import { type ChangeEvent, type FormEvent, useState } from "react";
import { submitForValidation, uploadNotes, uploadTranscript, type Workflow } from "../../api-client/client";
import { translateError } from "../../api-client/translateError";
import { BackOrCancel } from "../../components/BackOrCancel";
import { extractFileText } from "./extractFileText";

// A single source field that accepts either a pasted-in textarea value or an
// uploaded file (Phase 11 feedback item 3) -- both paths write to the same
// piece of state, so the existing paste-text behavior (and its tests) keep
// working unchanged, and the user can still edit after uploading a file.
function FileOrPasteField({
  id,
  label,
  instructions,
  value,
  onChange,
  required,
}: {
  id: string;
  label: string;
  instructions: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  const [fileError, setFileError] = useState<string | null>(null);

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setFileError(null);
    try {
      onChange(await extractFileText(file));
    } catch (err) {
      setFileError(err instanceof Error ? err.message : "Kon het bestand niet lezen.");
    }
  }

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <p className="helper-text">{instructions}</p>
      <input type="file" accept=".txt,.docx,.pdf,text/plain" aria-label={`${label} als bestand uploaden`} onChange={handleFile} />
      {fileError && <p role="alert">{fileError}</p>}
      <textarea id={id} value={value} onChange={(event) => onChange(event.target.value)} required={required} rows={10} />
    </div>
  );
}

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
          <FileOrPasteField
            id="upload-notes"
            label="Notities (optioneel)"
            instructions="Upload hier aanvullende eigen notities. Deze kunnen bijvoorbeeld bestaan uit observaties, actiepunten of aanvullende context. De AI gebruikt deze informatie om het transcript aan te vullen, maar behandelt conflicten met het transcript apart."
            value={notes}
            onChange={setNotes}
          />
          <div className="actions">
            <button type="submit" className="button-primary" disabled={submitting || transcript.trim().length === 0}>
              Uploaden en indienen voor validatie
            </button>
            <BackOrCancel mode="back" />
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
