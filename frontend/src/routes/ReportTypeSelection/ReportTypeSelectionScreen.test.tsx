import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ReportTypePolicy, type ReportTypeSuggestion, type Workflow } from "../../api-client/client";
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

const POLICIES: ReportTypePolicy[] = [
  { key: "thematic", displayName: "Thematisch gespreksverslag" },
  { key: "qa", displayName: "Vraag & antwoord gespreksverslag" },
];

function suggestion(overrides: Partial<ReportTypeSuggestion> = {}): ReportTypeSuggestion {
  return {
    id: "s1",
    workflowId: "w1",
    version: 1,
    aiOutputId: "a1",
    suggestedType: "thematic",
    rationale: "Het gesprek volgt geen strikte vraag/antwoord-structuur.",
    runnerUp: "qa",
    createdAt: "2026-01-01",
    ...overrides,
  };
}

function renderScreen(props: Partial<Parameters<typeof ReportTypeSelectionScreen>[0]> = {}) {
  return render(
    <MemoryRouter>
      <ReportTypeSelectionScreen workflow={workflow()} currentUserId="u1" onUpdated={vi.fn()} {...props} />
    </MemoryRouter>,
  );
}

function mockLoaded(suggestionOverrides: Partial<ReportTypeSuggestion> = {}) {
  vi.spyOn(client, "getReportTypePolicies").mockResolvedValue(POLICIES);
  vi.spyOn(client, "getReportTypeSuggestion").mockResolvedValue(suggestion(suggestionOverrides));
}

describe("routes/ReportTypeSelection/ReportTypeSelectionScreen", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the suggestion, its rationale, and a resolved Dutch display name (not the raw catalog key)", async () => {
    mockLoaded();

    renderScreen();

    await screen.findByText("Voorgesteld verslagtype: Thematisch gespreksverslag");
    expect(screen.getByText(suggestion().rationale)).toBeInTheDocument();
    expect(screen.queryByText("thematic")).not.toBeInTheDocument();
  });

  it("offers every active report type, not just the AI's suggestion, with the suggestion preselected and marked", async () => {
    mockLoaded();

    renderScreen();

    const thematicOption = (await screen.findByLabelText(/Thematisch gespreksverslag/)) as HTMLInputElement;
    const qaOption = screen.getByLabelText(/Vraag & antwoord gespreksverslag/) as HTMLInputElement;
    expect(thematicOption.checked).toBe(true);
    expect(qaOption.checked).toBe(false);
    expect(screen.getByText(/voorgesteld door de AI/)).toBeInTheDocument();
  });

  // Requirement C: exactly two report types exist -- "Acties en vervolgstappen"
  // is an optional section of both, never a report type or variant of one,
  // so the picker must never render a third option (e.g. "... (met acties)").
  it("C: renders exactly two report type options, never a third variant based on actions", async () => {
    mockLoaded();

    renderScreen();

    await screen.findByLabelText(/Thematisch gespreksverslag/);
    const options = screen.getAllByRole("radio");
    expect(options).toHaveLength(2);
    expect(screen.queryByText(/met acties/i)).not.toBeInTheDocument();
  });

  it("tolerates a 404 (no suggestion yet) without showing an error", async () => {
    vi.spyOn(client, "getReportTypePolicies").mockResolvedValue(POLICIES);
    vi.spyOn(client, "getReportTypeSuggestion").mockRejectedValue(new ApiError(404, "No report type suggestion yet"));

    renderScreen();

    await screen.findByText(/nog een verslagtype voorgesteld/);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("confirming without changing the selection submits the suggested type", async () => {
    mockLoaded();
    vi.spyOn(client, "selectReportType").mockResolvedValue(workflow({ currentState: "GENERATING_DRAFT" }));
    const onUpdated = vi.fn();

    renderScreen({ onUpdated });

    fireEvent.click(await screen.findByRole("button", { name: "Bevestigen en doorgaan" }));

    await waitFor(() =>
      expect(client.selectReportType).toHaveBeenCalledWith("w1", { actorId: "u1", reportType: "thematic" }),
    );
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ currentState: "GENERATING_DRAFT" }));
  });

  it("lets the operator deviate from the AI's suggestion and submits the chosen type instead", async () => {
    mockLoaded();
    vi.spyOn(client, "selectReportType").mockResolvedValue(workflow({ currentState: "GENERATING_DRAFT" }));
    const onUpdated = vi.fn();

    renderScreen({ onUpdated });

    fireEvent.click(await screen.findByLabelText(/Vraag & antwoord gespreksverslag/));
    fireEvent.click(screen.getByRole("button", { name: "Bevestigen en doorgaan" }));

    await waitFor(() => expect(client.selectReportType).toHaveBeenCalledWith("w1", { actorId: "u1", reportType: "qa" }));
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ currentState: "GENERATING_DRAFT" }));
  });

  it("offers a cancel control", async () => {
    mockLoaded();

    renderScreen();

    await screen.findByRole("button", { name: "Bevestigen en doorgaan" });
    expect(screen.getByRole("button", { name: "Workflow annuleren" })).toBeInTheDocument();
  });

  it("shows a translated load error that isn't a 404", async () => {
    vi.spyOn(client, "getReportTypePolicies").mockResolvedValue(POLICIES);
    vi.spyOn(client, "getReportTypeSuggestion").mockRejectedValue(new Error("boom"));

    renderScreen();

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Er is een fout opgetreden."));
  });
});
