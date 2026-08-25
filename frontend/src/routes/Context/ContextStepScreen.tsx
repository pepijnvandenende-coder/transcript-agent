import { useEffect, useState } from "react";
import {
  continueToTranscript,
  getContextTypePolicies,
  uploadContext,
  uploadNotes,
  type ContextTypePolicy,
  type Workflow,
} from "../../api-client/client";
import { translateError } from "../../api-client/translateError";
import { BackOrCancel } from "../../components/BackOrCancel";
import { FileOrPasteField } from "../../components/FileOrPasteField";

// Rendered by WorkflowPage for CONTEXT_INPUT -- Phase 19's own, dedicated
// step, shown before the transcript screen (Upload/UploadScreen.tsx, now
// CREATED-only). Every workflow passes through here first (see
// workflow/transitions.ts's "continue_to_transcript" edge -- CREATED is only
// reachable from CONTEXT_INPUT), but nothing on this screen is required:
// "Doorgaan naar transcript" works with every field left empty.
//
// Notes moved here from UploadScreen (still POSTed via uploadNotes, its own
// dedicated table/route -- see prisma/schema.prisma's Note comment for why
// that stays separate from ContextItem) so the user gives all optional
// background material -- notes, PvA, normenkader, vragenlijst, ... -- in one
// place, rather than notes living on the transcript screen and everything
// else on a separate one.
export function ContextStepScreen({
  workflow,
  currentUserId,
  onUpdated,
}: {
  workflow: Workflow;
  currentUserId: string;
  onUpdated: (workflow: Workflow) => void;
}) {
  const [notes, setNotes] = useState("");
  const [contextTypePolicies, setContextTypePolicies] = useState<ContextTypePolicy[]>([]);
  const [context, setContext] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Catalog-driven (backend/src/persistence/repositories/contextTypePolicyRepository.ts)
  // -- which fields render here changes by editing that catalog, not this
  // component. Failing silently (empty list) rather than surfacing
  // loadError: every field on this screen is optional, so an operator can
  // still continue to the transcript step without it.
  useEffect(() => {
    getContextTypePolicies()
      .then(setContextTypePolicies)
      .catch(() => setContextTypePolicies([]));
  }, []);

  async function handleContinue() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (notes.trim().length > 0) {
        await uploadNotes(workflow.id, { uploadedById: currentUserId, content: notes });
      }
      for (const policy of contextTypePolicies) {
        const content = context[policy.key];
        if (content && content.trim().length > 0) {
          await uploadContext(workflow.id, { uploadedById: currentUserId, contextType: policy.key, content });
        }
      }
      const updated = await continueToTranscript(workflow.id, { actorId: currentUserId });
      onUpdated(updated);
    } catch (err) {
      setSubmitError(translateError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="section">
      <p className="page-intro">
        Voeg hier informatie toe die de AI mag gebruiken bij het opstellen en analyseren van het gespreksverslag,
        zoals een plan van aanpak, normenkader, vragenlijst of eigen notities. Dit is optioneel -- je kunt ook
        direct doorgaan naar het transcript.
      </p>

      <FileOrPasteField
        id="context-notes"
        label="Notities (optioneel)"
        instructions="Eigen notities, zoals observaties of actiepunten. De AI gebruikt deze om het transcript aan te vullen, maar behandelt conflicten met het transcript apart."
        value={notes}
        onChange={setNotes}
      />

      {contextTypePolicies.map((policy) => (
        <FileOrPasteField
          key={policy.key}
          id={`context-${policy.key}`}
          label={`${policy.displayName} (optioneel)`}
          instructions={policy.description ?? ""}
          value={context[policy.key] ?? ""}
          onChange={(value) => setContext((prev) => ({ ...prev, [policy.key]: value }))}
        />
      ))}

      <div className="actions">
        <button type="button" className="button-primary" onClick={handleContinue} disabled={submitting}>
          Doorgaan naar transcript
        </button>
        <BackOrCancel mode="back" />
      </div>
      {submitError && <p role="alert">{submitError}</p>}
    </div>
  );
}
