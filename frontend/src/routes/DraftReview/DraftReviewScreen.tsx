import { useEffect, useState } from "react";
import {
  getDrafts,
  reviewDraft,
  type Draft,
  type DraftPrecheck,
  type PrecheckStatus,
  type Workflow,
} from "../../api-client/client";
import { translateError } from "../../api-client/translateError";
import { BackOrCancel } from "../../components/BackOrCancel";
import { parseContentBlocks, parseOpenQuestionBlocks } from "../../rendering/parseContentBlocks";

// Phase 15 item 2: showing only the failing items (as one summarizing
// sentence) made correct items read as "missing" whenever they happened to
// be bundled with something that failed -- every item is rendered on its
// own line instead of being collapsed into a single sentence.
//
// Phase 19 item 1: a bare ✓/⚠ marker couldn't distinguish "the source never
// mentioned this, nothing to flag" from "this needs your attention", and
// gave no reason for a warning beyond the item's fixed label. Four markers
// now map to the backend's PrecheckStatus (see ai/skillEnvelope.ts), and
// `detail` (always present) is shown alongside every item so a warning is
// never just a bare word -- see draftQualityPrecheck.ts.
const STATUS_MARKERS: Record<PrecheckStatus, string> = {
  ok: "✓",
  info: "ℹ",
  warning: "⚠",
  problem: "✕",
};

function PrecheckChecklist({ precheck }: { precheck: DraftPrecheck }) {
  return (
    <>
      <ul>
        {precheck.checklist.map((entry) => (
          <li key={entry.item}>
            {STATUS_MARKERS[entry.status]} {entry.item} -- {entry.detail}
          </li>
        ))}
      </ul>
      <p>{precheck.recommendation}</p>
    </>
  );
}

// Matches the canonical heading both report-type prompts use for this
// section (see backend/src/ai/prompts/reportTypes/{thematic,qa}.md) --
// backend/src/approval/reportStructureValidator.ts relies on the same
// exact-string match, so the model is already expected to emit this heading
// verbatim.
const OPEN_QUESTIONS_HEADING = "Openstaande vragen / onduidelijkheden";

// "Openstaande vragen / onduidelijkheden" renders one block per question
// (label + duiding kept together, via a <br/> between their lines) with a
// blank line's worth of gap to the next block -- not a bullet list -- so the
// blank line the model puts between questions stays visible on screen,
// matching parseOpenQuestionBlocks()'s doc comment and finalRenderer.ts's
// matching .docx rendering.
function OpenQuestionsContent({ content }: { content: string }) {
  const blocks = parseOpenQuestionBlocks(content);
  return (
    <>
      {blocks.map((block, index) => (
        <p key={index}>
          {block.split("\n").map((line, lineIndex) => (
            <span key={lineIndex}>
              {lineIndex > 0 && <br />}
              {line}
            </span>
          ))}
        </p>
      ))}
    </>
  );
}

// Phase 16 item 2: "Acties en vervolgstappen" (and any other section whose
// content is a markdown table -- the report prompts already ask the model
// for one, see ai/prompts/reportTypes/{thematic,qa}.md) must render as a
// real table, not one <p> per pipe-delimited line. Bullet lists get the same
// treatment for the same reason; anything else still renders as plain
// paragraphs, same as before.
function SectionContent({ heading, content }: { heading: string; content: string }) {
  if (heading === OPEN_QUESTIONS_HEADING) {
    return <OpenQuestionsContent content={content} />;
  }

  const blocks = parseContentBlocks(content);
  return (
    <>
      {blocks.map((block, index) => {
        if (block.type === "table") {
          return (
            <table key={index}>
              <thead>
                <tr>
                  {block.headers.map((header, headerIndex) => (
                    <th key={headerIndex}>{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          );
        }
        if (block.type === "bullets") {
          return (
            <ul key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{item}</li>
              ))}
            </ul>
          );
        }
        return <p key={index}>{block.text}</p>;
      })}
    </>
  );
}

// Rendered by WorkflowPage for DRAFT_PENDING_REVIEW. Covers both "Draft
// Review" and "Revision feedback" from the request -- per
// drafts.routes.ts's POST /workflows/:id/drafts/:version/review, approving
// and requesting changes are the same endpoint (`decision`), not two
// screens.
export function DraftReviewScreen({
  workflow,
  currentUserId,
  onUpdated,
}: {
  workflow: Workflow;
  currentUserId: string;
  onUpdated: (workflow: Workflow) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    getDrafts(workflow.id)
      .then((drafts) => setDraft(drafts[drafts.length - 1] ?? null))
      .catch((err) => setLoadError(translateError(err)));
  }, [workflow.id]);

  async function handleApprove() {
    if (!draft) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const updated = await reviewDraft(workflow.id, draft.version, { actorId: currentUserId, decision: "approve" });
      onUpdated(updated);
    } catch (err) {
      setSubmitError(translateError(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRequestChanges() {
    if (!draft || feedback.trim().length === 0) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const updated = await reviewDraft(workflow.id, draft.version, {
        actorId: currentUserId,
        decision: "request_changes",
        feedback: feedback.trim(),
      });
      onUpdated(updated);
    } catch (err) {
      setSubmitError(translateError(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (loadError) return <p role="alert">{loadError}</p>;
  if (!draft) return <p>Concept wordt geladen...</p>;

  return (
    <>
      <div className="section">
        <h2>{draft.title}</h2>
        <p>Aanwezige deelnemers: {draft.attendees.length > 0 ? draft.attendees.join(", ") : "Niet vastgelegd"}</p>
        <p>Datum: {draft.date}</p>
        <p>Onderwerp: {draft.subject}</p>

        {draft.precheck && (
          <div className="section">
            <h3>Kwaliteitscontrole</h3>
            <PrecheckChecklist precheck={draft.precheck} />
          </div>
        )}

        {draft.sections.map((section) => (
          <section key={section.heading}>
            <h3>{section.heading}</h3>
            <SectionContent heading={section.heading} content={section.content} />
          </section>
        ))}
      </div>

      <div className="section">
        <div className="actions">
          <button type="button" className="button-primary" onClick={handleApprove} disabled={submitting}>
            Goedkeuren
          </button>
        </div>

        <div className="field">
          <label htmlFor="draft-feedback">Feedback voor wijzigingen</label>
          <textarea id="draft-feedback" value={feedback} onChange={(event) => setFeedback(event.target.value)} rows={4} />
        </div>
        <div className="actions">
          <button
            type="button"
            className="button-secondary"
            onClick={handleRequestChanges}
            disabled={submitting || feedback.trim().length === 0}
          >
            Wijzigingen aanvragen
          </button>
          <BackOrCancel mode="cancel" workflowId={workflow.id} currentUserId={currentUserId} onCancelled={onUpdated} />
        </div>

        {submitError && <p role="alert">{submitError}</p>}
      </div>
    </>
  );
}
