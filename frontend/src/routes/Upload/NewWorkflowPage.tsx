import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createWorkflow } from "../../api-client/client";

// "/" -- the very first step of the Upload journey: create a workflow, then
// hand off to UploadPage for everything else (transcript/notes, submit for
// validation, status).
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
      setError(err instanceof Error ? err.message : "Onbekende fout");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main>
      <h1>Nieuw gespreksverslag starten</h1>
      <form onSubmit={handleSubmit}>
        <label>
          Titel
          <input value={title} onChange={(event) => setTitle(event.target.value)} required />
        </label>
        <button type="submit" disabled={submitting || title.trim().length === 0}>
          Aanmaken
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
