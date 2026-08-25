import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createWorkflow } from "../../api-client/client";
import { translateError } from "../../api-client/translateError";
import { Layout } from "../../components/Layout";

// "/" -- the very first step of the Upload journey: create a workflow, then
// hand off to UploadScreen for everything else (transcript/notes, submit for
// validation, status). Copy rewritten per Phase 11 feedback item 1: the
// heading is the question itself, so it's immediately clear this creates a
// gespreksverslag for a specific meeting, not an abstract "workflow". Copy
// updated again in Phase 16 (exact wording per that request) and moved onto
// the shared Layout component, centered like every other short screen.
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
    <Layout title="Voor welke vergadering wil je een gespreksverslag genereren?" centered>
      <p className="page-intro">
        Vul de naam of het onderwerp van de vergadering in. Vervolgens geef je eventueel aanvullende context mee en
        upload je het transcript.
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
    </Layout>
  );
}
