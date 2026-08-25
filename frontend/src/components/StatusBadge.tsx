import type { WorkflowState } from "../api-client/client";

// Minimal, genuinely shared component: Upload's own status view needs this
// now, and every later route (ConflictReview, DraftReview, ...) will need
// the same "show me the current state in plain language" display -- not a
// speculative abstraction.
const LABELS: Record<WorkflowState, string> = {
  CONTEXT_INPUT: "Aanvullende context",
  CREATED: "Aangemaakt",
  TRANSCRIPT_UPLOADED: "Transcript geüpload",
  VALIDATING_TRANSCRIPT: "Transcript wordt gevalideerd...",
  TRANSCRIPT_INSUFFICIENT: "Transcript onvoldoende",
  PENDING_HUMAN_CONFIRMATION: "Wacht op menselijke bevestiging",
  MERGING: "Wordt samengevoegd...",
  DETECTING_CONFLICTS: "Conflicten worden gedetecteerd...",
  CONFLICTS_PENDING_REVIEW: "Conflicten wachten op review",
  SUGGESTING_REPORT_TYPE: "Verslagtype wordt voorgesteld...",
  AWAITING_REPORT_TYPE_SELECTION: "Wacht op keuze verslagtype",
  GENERATING_DRAFT: "Concept wordt opgesteld...",
  DRAFT_QUALITY_PRECHECK: "Conceptcontrole...",
  DRAFT_PENDING_REVIEW: "Concept wacht op review",
  REVISING_DRAFT: "Concept wordt herzien...",
  GENERATING_FINAL: "Eindrapport wordt gegenereerd...",
  POST_PROCESSING: "Vervolgonderzoek wordt uitgevoerd...",
  COMPLETED: "Voltooid",
  CANCELLED: "Geannuleerd",
  FAILED: "Mislukt",
};

// Coarse visual category, not a 1:1 mirror of every FSM state -- only used
// for a background color hint.
const PROCESSING_STATES = new Set<WorkflowState>([
  "VALIDATING_TRANSCRIPT",
  "MERGING",
  "DETECTING_CONFLICTS",
  "SUGGESTING_REPORT_TYPE",
  "GENERATING_DRAFT",
  "DRAFT_QUALITY_PRECHECK",
  "REVISING_DRAFT",
  "GENERATING_FINAL",
  "POST_PROCESSING",
]);
const NEEDS_ATTENTION_STATES = new Set<WorkflowState>([
  "TRANSCRIPT_INSUFFICIENT",
  "PENDING_HUMAN_CONFIRMATION",
  "CONFLICTS_PENDING_REVIEW",
  "AWAITING_REPORT_TYPE_SELECTION",
  "DRAFT_PENDING_REVIEW",
  "FAILED",
]);

function colorFor(state: WorkflowState): string {
  if (state === "COMPLETED") return "#1a7f37";
  if (state === "CANCELLED" || state === "FAILED") return "#b71c1c";
  if (NEEDS_ATTENTION_STATES.has(state)) return "#a15c00";
  if (PROCESSING_STATES.has(state)) return "#0969da";
  return "#57606a";
}

export function StatusBadge({ state }: { state: WorkflowState }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: "999px",
        fontSize: "0.85rem",
        color: "white",
        backgroundColor: colorFor(state),
      }}
    >
      {LABELS[state]}
    </span>
  );
}
