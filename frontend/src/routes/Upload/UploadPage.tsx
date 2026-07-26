import { type FormEvent, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getWorkflow, submitForValidation, uploadNotes, uploadTranscript, type Workflow } from "../../api-client/client";
import { StatusBadge } from "../../components/StatusBadge";

const POLL_INTERVAL_MS = 1500;
const SLOW_HINT_AFTER_MS = 10000;

// "/workflows/:id" -- the refreshable/shareable rest of the Upload journey:
// upload transcript (+ optional notes), submit for validation, then poll
// and display whatever state comes next. Ends the moment the workflow
// leaves VALIDATING_TRANSCRIPT -- confirming low confidence, reviewing
// conflicts, etc. are each their own later-phase screen, not built here.
export function UploadPage({ currentUserId }: { currentUserId: string }) {
  const { id } = useParams<{ id: string }>();
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pollingElapsedMs, setPollingElapsedMs] = useState(0);

  useEffect(() => {
    if (!id) return;
    getWorkflow(id)
      .then(setWorkflow)
      .catch((err) => setLoadError(err instanceof Error ? err.message : "Onbekende fout"));
  }, [id]);

  // Polls while VALIDATING_TRANSCRIPT; stops the moment the state moves on
  // (setWorkflow is only called here once it has). The job queue is a
  // separate `npm run worker` process -- easy to forget, hence the hint.
  useEffect(() => {
    if (!id || !workflow || workflow.currentState !== "VALIDATING_TRANSCRIPT") return;

    const startedAt = Date.now();
    const interval = setInterval(() => {
      setPollingElapsedMs(Date.now() - startedAt);
      getWorkflow(id)
        .then((updated) => {
          if (updated.currentState !== "VALIDATING_TRANSCRIPT") {
            setWorkflow(updated);
          }
        })
        .catch(() => {
          // Transient poll failure -- the next tick retries; not surfaced as
          // a hard error.
        });
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [id, workflow]);

  async function handleUploadAndSubmit(event: FormEvent) {
    event.preventDefault();
    if (!id) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await uploadTranscript(id, { uploadedById: currentUserId, content: transcript });
      if (notes.trim().length > 0) {
        await uploadNotes(id, { uploadedById: currentUserId, content: notes });
      }
      const updated = await submitForValidation(id, { actorId: currentUserId });
      setPollingElapsedMs(0);
      setWorkflow(updated);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Onbekende fout");
    } finally {
      setSubmitting(false);
    }
  }

  // Resumption case: transcript was already uploaded (e.g. the browser was
  // closed before submit-for-validation completed) -- no need to re-upload.
  async function handleSubmitOnly() {
    if (!id) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const updated = await submitForValidation(id, { actorId: currentUserId });
      setPollingElapsedMs(0);
      setWorkflow(updated);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Onbekende fout");
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError) return <p role="alert">{loadError}</p>;
  if (!workflow) return <p>Laden...</p>;

  return (
    <main>
      <h1>{workflow.title}</h1>
      <StatusBadge state={workflow.currentState} />

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

      {workflow.currentState === "VALIDATING_TRANSCRIPT" && pollingElapsedMs > SLOW_HINT_AFTER_MS && (
        <p>Dit duurt langer dan verwacht. Draait de worker? (`npm run worker` in de backend)</p>
      )}

      {(workflow.currentState === "PENDING_HUMAN_CONFIRMATION" || workflow.currentState === "TRANSCRIPT_INSUFFICIENT") && (
        <p>Dit vraagt om een scherm dat nog niet gebouwd is (ConfirmLowConfidence).</p>
      )}

      {submitError && <p role="alert">{submitError}</p>}
    </main>
  );
}
