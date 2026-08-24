import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type FinalReport, type PostProcessingResult, type Workflow } from "../../api-client/client";
import * as client from "../../api-client/client";
import { FinalDownloadScreen } from "./FinalDownloadScreen";

function postProcessingResult(overrides: Partial<PostProcessingResult> = {}): PostProcessingResult {
  return {
    id: "pp1",
    workflowId: "w1",
    skillKey: "open_questions",
    displayName: "Openstaande vragen",
    status: "COMPLETED",
    resultJson: { open_questions: [] },
    errorMessage: null,
    createdAt: "2026-01-01",
    ...overrides,
  };
}

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

  // Phase 16 item 6: no report title, format, or timestamp -- just the fixed
  // "gereed" message and one centered primary download action. No second
  // (dead -- COMPLETED is a terminal FSM state) cancel control either.
  it("shows the fixed 'gereed' message and a single primary download action, with no technical details", async () => {
    vi.spyOn(client, "getFinalReport").mockResolvedValue(finalReport());

    renderScreen();

    await screen.findByText("Uw gespreksverslag is gereed.");
    expect(screen.queryByText("Gespreksverslag Kickoff")).not.toBeInTheDocument();
    expect(screen.queryByText(/Formaat/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Aangemaakt/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Workflow annuleren" })).not.toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Download gespreksverslag" });
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
    await screen.findByText("Uw gespreksverslag is gereed.");
  });

  it("shows a translated load error that isn't a 404", async () => {
    vi.spyOn(client, "getFinalReport").mockRejectedValue(new Error("boom"));

    renderScreen();

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Er is een fout opgetreden."));
  });

  it("does not offer a cancel control while the report isn't ready yet -- COMPLETED is terminal", async () => {
    vi.spyOn(client, "getFinalReport").mockRejectedValue(new ApiError(404, "Final report not available yet"));

    renderScreen();

    await screen.findByText("Eindrapport nog niet beschikbaar, probeer te vernieuwen.");
    expect(screen.queryByRole("button", { name: "Workflow annuleren" })).not.toBeInTheDocument();
  });

  describe("Vervolgonderzoek section (Phase 18)", () => {
    it("shows no follow-up section when there are no post-processing results", async () => {
      vi.spyOn(client, "getFinalReport").mockResolvedValue(finalReport());
      vi.spyOn(client, "getPostProcessingResults").mockResolvedValue([]);

      renderScreen();

      await screen.findByText("Uw gespreksverslag is gereed.");
      expect(screen.queryByText("Vervolgonderzoek")).not.toBeInTheDocument();
    });

    it("renders open questions results", async () => {
      vi.spyOn(client, "getFinalReport").mockResolvedValue(finalReport());
      vi.spyOn(client, "getPostProcessingResults").mockResolvedValue([
        postProcessingResult({
          resultJson: {
            open_questions: [{ question: "Is de planning definitief?", explanation: "Nog niet bevestigd in het gesprek." }],
          },
        }),
      ]);

      renderScreen();

      await screen.findByText("Vervolgonderzoek");
      expect(screen.getByText("Openstaande vragen")).toBeInTheDocument();
      expect(screen.getByText("Is de planning definitief?")).toBeInTheDocument();
      expect(screen.getByText("Nog niet bevestigd in het gesprek.")).toBeInTheDocument();
    });

    // Fix: open questions must render as one visual block per question --
    // not a bullet list -- with clear vertical spacing between blocks, and
    // the duiding/context nested under its own question. Structural DOM
    // assertions rather than a snapshot, per the UX fix request.
    it("renders open questions as separate blocks with no bullet list, and spacing between them", async () => {
      vi.spyOn(client, "getFinalReport").mockResolvedValue(finalReport());
      vi.spyOn(client, "getPostProcessingResults").mockResolvedValue([
        postProcessingResult({
          resultJson: {
            open_questions: [
              { question: "Is de planning definitief?", explanation: "Nog niet bevestigd in het gesprek." },
              { question: "Wie is verantwoordelijk voor de opvolging?", explanation: "Dit is niet toegewezen." },
            ],
          },
        }),
      ]);

      renderScreen();

      const section = (await screen.findByText("Openstaande vragen")).closest(".section") as HTMLElement;

      // No bullet list anywhere in this section.
      expect(section.querySelectorAll("ul, li")).toHaveLength(0);

      // Each question is a distinct block containing its number, its own
      // question text, and its own duiding directly beneath it.
      const blocks = section.querySelectorAll(".open-question");
      expect(blocks).toHaveLength(2);

      expect(blocks[0]).toHaveTextContent("1.");
      expect(blocks[0]).toHaveTextContent("Is de planning definitief?");
      expect(blocks[0]).toHaveTextContent("Nog niet bevestigd in het gesprek.");
      expect(blocks[0]).not.toHaveTextContent("Wie is verantwoordelijk voor de opvolging?");

      expect(blocks[1]).toHaveTextContent("2.");
      expect(blocks[1]).toHaveTextContent("Wie is verantwoordelijk voor de opvolging?");
      expect(blocks[1]).toHaveTextContent("Dit is niet toegewezen.");
      expect(blocks[1]).not.toHaveTextContent("Is de planning definitief?");

      // Blocks share a common container styled (see styles.css's
      // ".open-questions" rule) with a real vertical gap between children --
      // asserted here via the class hook rather than jsdom's unstyled
      // getComputedStyle, since no stylesheet is loaded in this test env.
      const container = blocks[0].parentElement as HTMLElement;
      expect(container).toHaveClass("open-questions");
    });

    it("renders criteria/norm coverage results with their status", async () => {
      vi.spyOn(client, "getFinalReport").mockResolvedValue(finalReport());
      vi.spyOn(client, "getPostProcessingResults").mockResolvedValue([
        postProcessingResult({
          skillKey: "norm_coverage",
          displayName: "Normenkader / criteria coverage",
          resultJson: {
            items: [{ criterion: "Toegangsbeveiliging", status: "partially_covered", explanation: "Deels besproken." }],
          },
        }),
      ]);

      renderScreen();

      await screen.findByText("Normenkader / criteria coverage");
      expect(screen.getByText("Toegangsbeveiliging")).toBeInTheDocument();
      expect(screen.getByText(/Gedeeltelijk behandeld/)).toBeInTheDocument();
    });

    it("explains a skipped follow-up step instead of showing an empty result", async () => {
      vi.spyOn(client, "getFinalReport").mockResolvedValue(finalReport());
      vi.spyOn(client, "getPostProcessingResults").mockResolvedValue([
        postProcessingResult({
          skillKey: "norm_coverage",
          displayName: "Normenkader / criteria coverage",
          status: "SKIPPED",
          resultJson: null,
          errorMessage: 'Geen "normenkader" context aangeleverd voor deze workflow.',
        }),
      ]);

      renderScreen();

      await screen.findByText("Normenkader / criteria coverage");
      expect(screen.getByText('Geen "normenkader" context aangeleverd voor deze workflow.')).toBeInTheDocument();
    });

    it("shows a Dutch failure notice for a failed follow-up step", async () => {
      vi.spyOn(client, "getFinalReport").mockResolvedValue(finalReport());
      vi.spyOn(client, "getPostProcessingResults").mockResolvedValue([
        postProcessingResult({ status: "FAILED", resultJson: null, errorMessage: "Simulated failure" }),
      ]);

      renderScreen();

      await screen.findByText("Vervolgonderzoek");
      expect(screen.getByRole("alert")).toHaveTextContent("Deze analyse is niet gelukt.");
    });

    it("falls back to a generic rendering for a result shape it doesn't specifically recognize", async () => {
      vi.spyOn(client, "getFinalReport").mockResolvedValue(finalReport());
      vi.spyOn(client, "getPostProcessingResults").mockResolvedValue([
        postProcessingResult({
          skillKey: "risk_identification",
          displayName: "Risicoanalyse",
          resultJson: { risks: ["Onduidelijke planning"] },
        }),
      ]);

      renderScreen();

      await screen.findByText("Risicoanalyse");
      expect(screen.getByText(/Onduidelijke planning/)).toBeInTheDocument();
    });
  });
});
