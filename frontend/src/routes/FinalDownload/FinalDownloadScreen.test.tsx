import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type FinalReport, type Workflow } from "../../api-client/client";
import * as client from "../../api-client/client";
import { FinalDownloadScreen } from "./FinalDownloadScreen";

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "w1",
    title: "Test",
    currentState: "COMPLETED",
    reportType: "thematic",
    status: "COMPLETED",
    createdById: "u1",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...overrides,
  };
}

function finalReport(overrides: Partial<FinalReport> = {}): FinalReport {
  return {
    id: "f1",
    workflowId: "w1",
    draftId: "d1",
    aiOutputId: "a1",
    title: "Gespreksverslag Kickoff",
    format: "docx",
    storageRef: "w1/final-reports/report.docx",
    createdAt: "2026-01-01",
    ...overrides,
  };
}

function renderScreen(props: Partial<Parameters<typeof FinalDownloadScreen>[0]> = {}) {
  return render(
    <MemoryRouter>
      <FinalDownloadScreen workflow={workflow()} currentUserId="u1" onUpdated={vi.fn()} {...props} />
    </MemoryRouter>,
  );
}

describe("routes/FinalDownload/FinalDownloadScreen", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the final report metadata and a download link", async () => {
    vi.spyOn(client, "getFinalReport").mockResolvedValue(finalReport());

    renderScreen();

    await screen.findByText("Gespreksverslag Kickoff");
    expect(screen.getByText("Formaat: docx")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Download eindrapport" });
    expect(link).toHaveAttribute("href", "/workflows/w1/final-report/download");
  });

  it("tolerates a 404 with a 'not ready yet' message and a refresh button", async () => {
    const getFinalReportMock = vi
      .spyOn(client, "getFinalReport")
      .mockRejectedValueOnce(new ApiError(404, "Final report not available yet"))
      .mockResolvedValueOnce(finalReport());

    renderScreen();

    await screen.findByText("Eindrapport nog niet beschikbaar, probeer te vernieuwen.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Vernieuwen" }));

    await waitFor(() => expect(getFinalReportMock).toHaveBeenCalledTimes(2));
    await screen.findByText("Gespreksverslag Kickoff");
  });

  it("shows a translated load error that isn't a 404", async () => {
    vi.spyOn(client, "getFinalReport").mockRejectedValue(new Error("boom"));

    renderScreen();

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Er is een fout opgetreden."));
  });

  it("offers a cancel control even while the report isn't ready yet", async () => {
    vi.spyOn(client, "getFinalReport").mockRejectedValue(new ApiError(404, "Final report not available yet"));

    renderScreen();

    await screen.findByText("Eindrapport nog niet beschikbaar, probeer te vernieuwen.");
    expect(screen.getByRole("button", { name: "Workflow annuleren" })).toBeInTheDocument();
  });
});
