import { useParams } from "react-router-dom";
import type { Workflow, WorkflowState } from "../api-client/client";
import { JobStatusHint } from "../components/JobStatusHint";
import { Layout } from "../components/Layout";
import { StatusBadge } from "../components/StatusBadge";
import { isTransientState, SLOW_HINT_AFTER_MS, useWorkflow } from "../state/useWorkflow";
import { ConfirmLowConfidenceScreen } from "./ConfirmLowConfidence/ConfirmLowConfidenceScreen";
import { ConflictReviewScreen } from "./ConflictReview/ConflictReviewScreen";
import { DraftReviewScreen } from "./DraftReview/DraftReviewScreen";
import { FailedScreen } from "./Failed/FailedScreen";
import { FinalDownloadScreen } from "./FinalDownload/FinalDownloadScreen";
import { ReportTypeSelectionScreen } from "./ReportTypeSelection/ReportTypeSelectionScreen";
import { UploadScreen } from "./Upload/UploadScreen";

type ScreenProps = { workflow: Workflow; currentUserId: string; onUpdated: (workflow: Workflow) => void };
type ScreenComponent = (props: ScreenProps) => JSX.Element;

// The frontend's own small mirror of the backend's SKILL_ROUTING-style
// per-state dispatch -- which screen owns which WorkflowState.
const SCREENS: Partial<Record<WorkflowState, ScreenComponent>> = {
  CREATED: UploadScreen,
  TRANSCRIPT_UPLOADED: UploadScreen,
  VALIDATING_TRANSCRIPT: UploadScreen,
  PENDING_HUMAN_CONFIRMATION: ConfirmLowConfidenceScreen,
  CONFLICTS_PENDING_REVIEW: ConflictReviewScreen,
  AWAITING_REPORT_TYPE_SELECTION: ReportTypeSelectionScreen,
  DRAFT_PENDING_REVIEW: DraftReviewScreen,
  COMPLETED: FinalDownloadScreen,
  FAILED: FailedScreen,
};

// Not requested yet -- TRANSCRIPT_INSUFFICIENT stays unbuilt, showing the
// same placeholder note Upload already used.
const NOT_BUILT_STATES = new Set<WorkflowState>(["TRANSCRIPT_INSUFFICIENT"]);

// Phase 16: screens whose content is consistently short/sparse (a title, a
// status, one or two lines, one button) -- vertically centered via
// Layout's `centered` prop instead of pinned to the top of an otherwise-empty
// page. Screens with variable-length or form content (Upload, DraftReview,
// ...) keep the normal top-down flow.
const CENTERED_STATES = new Set<WorkflowState>(["COMPLETED", "FAILED"]);

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
    <Layout
      title={workflow.title}
      status={<StatusBadge state={workflow.currentState} />}
      centered={CENTERED_STATES.has(workflow.currentState)}
    >
      {Screen && <Screen workflow={workflow} currentUserId={currentUserId} onUpdated={setWorkflow} />}

      {!Screen && NOT_BUILT_STATES.has(workflow.currentState) && (
        <p>Dit vraagt om een scherm dat nog niet gebouwd is.</p>
      )}

      {!Screen && workflow.currentState === "CANCELLED" && <p>Deze workflow is geannuleerd.</p>}

      {isTransientState(workflow.currentState) && (
        <>
          <JobStatusHint workflowId={workflow.id} />
          {pollingElapsedMs > SLOW_HINT_AFTER_MS && (
            <p>Dit duurt langer dan verwacht. Draait de worker? (`npm run worker` in de backend)</p>
          )}
        </>
      )}
    </Layout>
  );
}
