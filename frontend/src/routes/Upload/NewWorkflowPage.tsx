import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createWorkflow } from "../../api-client/client";
import { translateError } from "../../api-client/translateError";

// "/" -- the very first step of the Upload journey: create a workflow, then
// hand off to UploadScreen for everything else (transcript/notes, submit for
// validation, status). Copy rewritten per Phase 11 feedback item 1: the
// heading is the question itself, so it's immediately clear this creates a
// gespreksverslag for a specific meeting, not an abstract "workflow".
export function NewWorkflowPage({ currentUserId }: { currentUserId: string }) {
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const workflow = await createWorkflow({ title, createdById: currentUserId });
      navigate(`/workflows/${workflow.id}`);
    } catch (err) {
      setError(translateError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="page">
      <h1>Van welke vergadering wil je een gespreksverslag maken?</h1>
      <p className="page-intro">
        Voer de naam van de vergadering of het gesprek in. Hiermee start je een nieuw gespreksverslag: je uploadt
        straks het transcript en eventuele aantekeningen, en doorloopt de stappen tot een definitief verslag.
      </p>
      <form onSubmit={handleSubmit} className="section">
        <div className="field">
          <label htmlFor="new-workflow-title">Naam van de vergadering</label>
          <input id="new-workflow-title" value={title} onChange={(event) => setTitle(event.target.value)} required />
        </div>
        <div className="actions">
          <button type="submit" className="button-primary" disabled={submitting || title.trim().length === 0}>
            Gespreksverslag starten
          </button>
        </div>
      </form>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
