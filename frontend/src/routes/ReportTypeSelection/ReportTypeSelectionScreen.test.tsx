import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ReportTypeSuggestion, type Workflow } from "../../api-client/client";
import * as client from "../../api-client/client";
import { ReportTypeSelectionScreen } from "./ReportTypeSelectionScreen";

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "w1",
    title: "Test",
    currentState: "AWAITING_REPORT_TYPE_SELECTION",
    reportType: null,
    status: "ACTIVE",
    createdById: "u1",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...overrides,
  };
}

function suggestion(overrides: Partial<ReportTypeSuggestion> = {}): ReportTypeSuggestion {
  return {
    id: "s1",
    workflowId: "w1",
    version: 1,
    aiOutputId: "a1",
    suggestedType: "Thematisch gespreksverslag",
    rationale: "Het gesprek volgt geen strikte vraag/antwoord-structuur.",
    runnerUp: "Vraag & antwoord gespreksverslag",
    createdAt: "2026-01-01",
    ...overrides,
  };
}

describe("routes/ReportTypeSelection/ReportTypeSelectionScreen", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the suggestion and runner-up as buttons", async () => {
    vi.spyOn(client, "getReportTypeSuggestion").mockResolvedValue(suggestion());

    render(<ReportTypeSelectionScreen workflow={workflow()} currentUserId="u1" onUpdated={vi.fn()} />);

    await screen.findByRole("button", { name: "Thematisch gespreksverslag kiezen" });
    expect(screen.getByRole("button", { name: "Vraag & antwoord gespreksverslag kiezen" })).toBeInTheDocument();
  });

  it("tolerates a 404 (no suggestion yet) without showing an error", async () => {
    vi.spyOn(client, "getReportTypeSuggestion").mockRejectedValue(new ApiError(404, "No report type suggestion yet"));

    render(<ReportTypeSelectionScreen workflow={workflow()} currentUserId="u1" onUpdated={vi.fn()} />);

    await screen.findByLabelText("Ander verslagtype");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clicking the suggested type calls selectReportType and onUpdated", async () => {
    vi.spyOn(client, "getReportTypeSuggestion").mockResolvedValue(suggestion());
    vi.spyOn(client, "selectReportType").mockResolvedValue(workflow({ currentState: "GENERATING_DRAFT" }));
    const onUpdated = vi.fn();

    render(<ReportTypeSelectionScreen workflow={workflow()} currentUserId="u1" onUpdated={onUpdated} />);

    fireEvent.click(await screen.findByRole("button", { name: "Thematisch gespreksverslag kiezen" }));

    await waitFor(() =>
      expect(client.selectReportType).toHaveBeenCalledWith("w1", {
        actorId: "u1",
        reportType: "Thematisch gespreksverslag",
      }),
    );
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ currentState: "GENERATING_DRAFT" }));
  });

  it("the free-text fallback is disabled until text is entered, and submits the typed value", async () => {
    vi.spyOn(client, "getReportTypeSuggestion").mockRejectedValue(new ApiError(404, "none yet"));
    vi.spyOn(client, "selectReportType").mockResolvedValue(workflow({ currentState: "GENERATING_DRAFT" }));

    render(<ReportTypeSelectionScreen workflow={workflow()} currentUserId="u1" onUpdated={vi.fn()} />);

    await screen.findByLabelText("Ander verslagtype");
    expect(screen.getByRole("button", { name: "Bevestigen" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Ander verslagtype"), { target: { value: "qa" } });
    expect(screen.getByRole("button", { name: "Bevestigen" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Bevestigen" }));

    await waitFor(() => expect(client.selectReportType).toHaveBeenCalledWith("w1", { actorId: "u1", reportType: "qa" }));
  });

  it("shows a load error that isn't a 404", async () => {
    vi.spyOn(client, "getReportTypeSuggestion").mockRejectedValue(new Error("Server fout"));

    render(<ReportTypeSelectionScreen workflow={workflow()} currentUserId="u1" onUpdated={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Server fout"));
  });
});
