import { useParams } from "react-router-dom";
import type { Workflow, WorkflowState } from "../api-client/client";
import { StatusBadge } from "../components/StatusBadge";
import { isTransientState, SLOW_HINT_AFTER_MS, useWorkflow } from "../state/useWorkflow";
import { ConflictReviewScreen } from "./ConflictReview/ConflictReviewScreen";
import { DraftReviewScreen } from "./DraftReview/DraftReviewScreen";
import { FinalDownloadScreen } from "./FinalDownload/FinalDownloadScreen";
import { ReportTypeSelectionScreen } from "./ReportTypeSelection/ReportTypeSelectionScreen";
import { UploadScreen } from "./Upload/UploadScreen";

type ScreenProps = { workflow: Workflow; currentUserId: string; onUpdated: (workflow: Workflow) => void };
type ScreenComponent = (props: ScreenProps) => JSX.Element;

// The frontend's own small mirror of the backend's SKILL_ROUTING-style
// per-state dispatch -- which screen owns which WorkflowState. Extending the
// operator UI to a state that doesn't have a screen yet (e.g.
// ConfirmLowConfidence) is exactly one more entry here plus one more
// component, following the same shape every screen already has.
const SCREENS: Partial<Record<WorkflowState, ScreenComponent>> = {
  CREATED: UploadScreen,
  TRANSCRIPT_UPLOADED: UploadScreen,
  VALIDATING_TRANSCRIPT: UploadScreen,
  CONFLICTS_PENDING_REVIEW: ConflictReviewScreen,
  AWAITING_REPORT_TYPE_SELECTION: ReportTypeSelectionScreen,
  DRAFT_PENDING_REVIEW: DraftReviewScreen,
  COMPLETED: FinalDownloadScreen,
};

// Not requested this phase -- ConfirmLowConfidence stays unbuilt; these
// states show the same placeholder note Upload already used.
const NOT_BUILT_STATES = new Set<WorkflowState>(["PENDING_HUMAN_CONFIRMATION", "TRANSCRIPT_INSUFFICIENT"]);

// "/workflows/:id" -- the single per-workflow route. Loads + polls via
// state/useWorkflow.ts, then renders whichever screen owns the current
// state (or a generic notice for a state with no screen yet).
export function WorkflowPage({ currentUserId }: { currentUserId: string }) {
  const { id } = useParams<{ id: string }>();
  const { workflow, error, pollingElapsedMs, setWorkflow } = useWorkflow(id!);

  if (error) return <p role="alert">{error}</p>;
  if (!workflow) return <p>Laden...</p>;

  const Screen = SCREENS[workflow.currentState];

  return (
    <main>
      <h1>{workflow.title}</h1>
      <StatusBadge state={workflow.currentState} />

      {Screen && <Screen workflow={workflow} currentUserId={currentUserId} onUpdated={setWorkflow} />}

      {!Screen && NOT_BUILT_STATES.has(workflow.currentState) && (
        <p>Dit vraagt om een scherm dat nog niet gebouwd is (ConfirmLowConfidence).</p>
      )}

      {!Screen && (workflow.currentState === "CANCELLED" || workflow.currentState === "FAILED") && (
        <p>Deze workflow is {workflow.currentState === "CANCELLED" ? "geannuleerd" : "mislukt"}.</p>
      )}

      {isTransientState(workflow.currentState) && pollingElapsedMs > SLOW_HINT_AFTER_MS && (
        <p>Dit duurt langer dan verwacht. Draait de worker? (`npm run worker` in de backend)</p>
      )}
    </main>
  );
}
