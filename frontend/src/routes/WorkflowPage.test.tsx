import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workflow } from "../api-client/client";
import * as useWorkflowModule from "../state/useWorkflow";
import { WorkflowPage } from "./WorkflowPage";

// WorkflowPage's own job is dispatch (which screen for which state) + the
// fallback/hint notices -- each screen's own behavior already has its own
// dedicated test file, so the screens are stubbed here to keep this test
// isolated to WorkflowPage's own logic.
vi.mock("./Upload/UploadScreen", () => ({ UploadScreen: () => <div>UploadScreenStub</div> }));
vi.mock("./ConflictReview/ConflictReviewScreen", () => ({ ConflictReviewScreen: () => <div>ConflictReviewScreenStub</div> }));
vi.mock("./ReportTypeSelection/ReportTypeSelectionScreen", () => ({
  ReportTypeSelectionScreen: () => <div>ReportTypeSelectionScreenStub</div>,
}));
vi.mock("./DraftReview/DraftReviewScreen", () => ({ DraftReviewScreen: () => <div>DraftReviewScreenStub</div> }));
vi.mock("./FinalDownload/FinalDownloadScreen", () => ({ FinalDownloadScreen: () => <div>FinalDownloadScreenStub</div> }));

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "w1",
    title: "Test",
    currentState: "CREATED",
    reportType: null,
    status: "ACTIVE",
    createdById: "u1",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...overrides,
  };
}

function mockUseWorkflow(overrides: Partial<ReturnType<typeof useWorkflowModule.useWorkflow>> = {}) {
  vi.spyOn(useWorkflowModule, "useWorkflow").mockReturnValue({
    workflow: workflow(),
    error: null,
    pollingElapsedMs: 0,
    setWorkflow: vi.fn(),
    ...overrides,
  });
}

function renderAt(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/workflows/${id}`]}>
      <Routes>
        <Route path="/workflows/:id" element={<WorkflowPage currentUserId="u1" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("routes/WorkflowPage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows a loading message before the workflow has loaded", () => {
    mockUseWorkflow({ workflow: null });
    renderAt("w1");
    expect(screen.getByText("Laden...")).toBeInTheDocument();
  });

  it("shows the load error as an alert", () => {
    mockUseWorkflow({ workflow: null, error: "Workflow not found" });
    renderAt("w1");
    expect(screen.getByRole("alert")).toHaveTextContent("Workflow not found");
  });

  it.each([
    ["CREATED", "UploadScreenStub"],
    ["TRANSCRIPT_UPLOADED", "UploadScreenStub"],
    ["VALIDATING_TRANSCRIPT", "UploadScreenStub"],
    ["CONFLICTS_PENDING_REVIEW", "ConflictReviewScreenStub"],
    ["AWAITING_REPORT_TYPE_SELECTION", "ReportTypeSelectionScreenStub"],
    ["DRAFT_PENDING_REVIEW", "DraftReviewScreenStub"],
    ["COMPLETED", "FinalDownloadScreenStub"],
  ] as const)("dispatches %s to %s", (state, expectedStub) => {
    mockUseWorkflow({ workflow: workflow({ currentState: state }) });
    renderAt("w1");
    expect(screen.getByText(expectedStub)).toBeInTheDocument();
  });

  it.each(["PENDING_HUMAN_CONFIRMATION", "TRANSCRIPT_INSUFFICIENT"] as const)(
    "shows the 'not built yet' notice for %s",
    (state) => {
      mockUseWorkflow({ workflow: workflow({ currentState: state }) });
      renderAt("w1");
      expect(screen.getByText(/nog niet gebouwd is/)).toBeInTheDocument();
    },
  );

  it("shows a plain terminal notice for CANCELLED", () => {
    mockUseWorkflow({ workflow: workflow({ currentState: "CANCELLED" }) });
    renderAt("w1");
    expect(screen.getByText("Deze workflow is geannuleerd.")).toBeInTheDocument();
  });

  it("shows a plain terminal notice for FAILED", () => {
    mockUseWorkflow({ workflow: workflow({ currentState: "FAILED" }) });
    renderAt("w1");
    expect(screen.getByText("Deze workflow is mislukt.")).toBeInTheDocument();
  });

  it("shows the slow-poll hint once elapsed time passes the threshold, for a transient state with no screen", () => {
    mockUseWorkflow({ workflow: workflow({ currentState: "MERGING" }), pollingElapsedMs: 15000 });
    renderAt("w1");
    expect(screen.getByText(/Draait de worker/)).toBeInTheDocument();
  });

  it("does not show the slow-poll hint before the threshold", () => {
    mockUseWorkflow({ workflow: workflow({ currentState: "MERGING" }), pollingElapsedMs: 1000 });
    renderAt("w1");
    expect(screen.queryByText(/Draait de worker/)).not.toBeInTheDocument();
  });

  it("shows the slow-poll hint alongside a screen when that screen's state is also transient", () => {
    mockUseWorkflow({ workflow: workflow({ currentState: "VALIDATING_TRANSCRIPT" }), pollingElapsedMs: 15000 });
    renderAt("w1");
    expect(screen.getByText("UploadScreenStub")).toBeInTheDocument();
    expect(screen.getByText(/Draait de worker/)).toBeInTheDocument();
  });
});
