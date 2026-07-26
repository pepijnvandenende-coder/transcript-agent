import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    format: "markdown",
    storageRef: "w1/final-reports/report.md",
    createdAt: "2026-01-01",
    ...overrides,
  };
}

describe("routes/FinalDownload/FinalDownloadScreen", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the final report metadata and a download link", async () => {
    vi.spyOn(client, "getFinalReport").mockResolvedValue(finalReport());

    render(<FinalDownloadScreen workflow={workflow()} currentUserId="u1" onUpdated={vi.fn()} />);

    await screen.findByText("Gespreksverslag Kickoff");
    expect(screen.getByText("Formaat: markdown")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Download eindrapport" });
    expect(link).toHaveAttribute("href", "/workflows/w1/final-report/download");
  });

  it("tolerates a 404 with a 'not ready yet' message and a refresh button", async () => {
    const getFinalReportMock = vi
      .spyOn(client, "getFinalReport")
      .mockRejectedValueOnce(new ApiError(404, "Final report not available yet"))
      .mockResolvedValueOnce(finalReport());

    render(<FinalDownloadScreen workflow={workflow()} currentUserId="u1" onUpdated={vi.fn()} />);

    await screen.findByText("Eindrapport nog niet beschikbaar, probeer te vernieuwen.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Vernieuwen" }));

    await waitFor(() => expect(getFinalReportMock).toHaveBeenCalledTimes(2));
    await screen.findByText("Gespreksverslag Kickoff");
  });

  it("shows a load error that isn't a 404", async () => {
    vi.spyOn(client, "getFinalReport").mockRejectedValue(new Error("Server fout"));

    render(<FinalDownloadScreen workflow={workflow()} currentUserId="u1" onUpdated={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Server fout"));
  });
});
