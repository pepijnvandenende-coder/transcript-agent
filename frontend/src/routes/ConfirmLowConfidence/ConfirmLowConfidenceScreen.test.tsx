import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, Workflow } from "../../api-client/client";
import * as client from "../../api-client/client";
import { ConfirmLowConfidenceScreen } from "./ConfirmLowConfidenceScreen";

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "w1",
    title: "Test",
    currentState: "PENDING_HUMAN_CONFIRMATION",
    reportType: null,
    status: "ACTIVE",
    createdById: "u1",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...overrides,
  };
}

function approvalRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "ar1",
    workflowId: "w1",
    aiOutputId: "ao1",
    intendedNextState: "MERGING",
    attemptCount: 1,
    status: "PENDING",
    resolution: null,
    createdAt: "2026-01-01",
    resolvedAt: null,
    aiOutput: {
      id: "ao1",
      skillName: "TranscriptQualityChecker",
      validationStatus: "VALID",
      validationErrors: null,
      confidenceScore: 0.62,
      confidenceBreakdown: { llmSelfReported: 0.5, structuralScore: 0.85, confidence: 0.62 },
      attemptNumber: 1,
    },
    maxRetries: 5,
    ...overrides,
  };
}

function renderScreen(props: Partial<Parameters<typeof ConfirmLowConfidenceScreen>[0]> = {}) {
  return render(
    <MemoryRouter>
      <ConfirmLowConfidenceScreen workflow={workflow()} currentUserId="u1" onUpdated={vi.fn()} {...props} />
    </MemoryRouter>,
  );
}

describe("routes/ConfirmLowConfidence/ConfirmLowConfidenceScreen", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the low-confidence explanation and rounded confidence percentage", async () => {
    vi.spyOn(client, "getApprovalRequest").mockResolvedValue(approvalRequest());

    renderScreen();

    await screen.findByText(/onvoldoende zeker of het transcript geschikt is/);
    expect(screen.getByText("Zekerheid van de AI: 62%.")).toBeInTheDocument();
    expect(screen.getByText("Poging 1 van maximaal 5.")).toBeInTheDocument();
  });

  it("shows the schema-invalid explanation and no percentage when validation failed", async () => {
    vi.spyOn(client, "getApprovalRequest").mockResolvedValue(
      approvalRequest({
        aiOutput: {
          id: "ao1",
          skillName: "Merger",
          validationStatus: "INVALID",
          validationErrors: [{ path: "result.merged_sections", message: "Required" }],
          confidenceScore: null,
          confidenceBreakdown: null,
          attemptNumber: 1,
        },
      }),
    );

    renderScreen();

    await screen.findByText("De AI kon voor deze stap geen bruikbaar resultaat opleveren. Een mens moet daarom beoordelen hoe de workflow verder moet.");
    expect(screen.getByText("De AI-uitvoer kon niet op zekerheid worden beoordeeld -- het formaat klopte niet.")).toBeInTheDocument();
    expect(screen.queryByText(/result.merged_sections/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Required/)).not.toBeInTheDocument();
  });

  it("shows only a transcript field to edit for TranscriptQualityChecker's checkpoint", async () => {
    vi.spyOn(client, "getApprovalRequest").mockResolvedValue(approvalRequest());

    renderScreen();

    await screen.findByLabelText("Aangepast transcript");
    expect(screen.queryByLabelText("Aangepaste notities")).not.toBeInTheDocument();
  });

  it("shows both transcript and notes fields to edit for Merger's checkpoint", async () => {
    vi.spyOn(client, "getApprovalRequest").mockResolvedValue(
      approvalRequest({ aiOutput: { ...approvalRequest().aiOutput, skillName: "Merger" } }),
    );

    renderScreen();

    await screen.findByLabelText("Aangepast transcript");
    expect(screen.getByLabelText("Aangepaste notities")).toBeInTheDocument();
  });

  it("offers no edit-and-retry option for ConflictDetector's checkpoint, with an explanation", async () => {
    vi.spyOn(client, "getApprovalRequest").mockResolvedValue(
      approvalRequest({ aiOutput: { ...approvalRequest().aiOutput, skillName: "ConflictDetector" } }),
    );

    renderScreen();

    await screen.findByText("Voor deze stap is er niets om aan te passen -- kies bevestigen of annuleer de workflow.");
    expect(screen.queryByLabelText("Aangepast transcript")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Aangepaste versie opnieuw laten controleren" })).not.toBeInTheDocument();
  });

  it("disables edit-and-retry once the retry budget is spent, with an explanation", async () => {
    vi.spyOn(client, "getApprovalRequest").mockResolvedValue(approvalRequest({ attemptCount: 5, maxRetries: 5 }));

    renderScreen();

    await screen.findByText("Je hebt het maximaal aantal pogingen bereikt voor deze stap -- kies bevestigen of annuleer de workflow.");
    expect(screen.queryByLabelText("Aangepast transcript")).not.toBeInTheDocument();
  });

  it("confirming calls confirmApprovalRequestAction and onUpdated", async () => {
    vi.spyOn(client, "getApprovalRequest").mockResolvedValue(approvalRequest());
    vi.spyOn(client, "confirmApprovalRequestAction").mockResolvedValue(workflow({ currentState: "MERGING" }));
    const onUpdated = vi.fn();

    renderScreen({ onUpdated });

    fireEvent.click(await screen.findByRole("button", { name: "Bevestigen en doorgaan" }));

    await waitFor(() => expect(client.confirmApprovalRequestAction).toHaveBeenCalledWith("w1", { actorId: "u1" }));
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ currentState: "MERGING" }));
  });

  it("edit-and-retry is disabled until a field is filled in, then submits only the filled field", async () => {
    vi.spyOn(client, "getApprovalRequest").mockResolvedValue(approvalRequest());
    vi.spyOn(client, "editRetryApprovalRequestAction").mockResolvedValue(workflow({ currentState: "VALIDATING_TRANSCRIPT" }));
    const onUpdated = vi.fn();

    renderScreen({ onUpdated });

    await screen.findByLabelText("Aangepast transcript");
    expect(screen.getByRole("button", { name: "Aangepaste versie opnieuw laten controleren" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Aangepast transcript"), { target: { value: "een aangepast transcript" } });
    fireEvent.click(screen.getByRole("button", { name: "Aangepaste versie opnieuw laten controleren" }));

    await waitFor(() =>
      expect(client.editRetryApprovalRequestAction).toHaveBeenCalledWith("w1", {
        actorId: "u1",
        transcriptContent: "een aangepast transcript",
        notesContent: undefined,
      }),
    );
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ currentState: "VALIDATING_TRANSCRIPT" }));
  });

  it("shows a translated load error", async () => {
    vi.spyOn(client, "getApprovalRequest").mockRejectedValue(new Error("boom"));

    renderScreen();

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Er is een fout opgetreden."));
  });

  it("offers a cancel control instead of a backward navigation edge", async () => {
    vi.spyOn(client, "getApprovalRequest").mockResolvedValue(approvalRequest());

    renderScreen();

    expect(await screen.findByRole("button", { name: "Workflow annuleren" })).toBeInTheDocument();
  });

  it("does not offer a plain retry-without-changes control", async () => {
    vi.spyOn(client, "getApprovalRequest").mockResolvedValue(approvalRequest());

    renderScreen();

    await screen.findByText("Bevestiging nodig");
    expect(screen.queryByText(/opnieuw proberen zonder/i)).not.toBeInTheDocument();
    expect(client.getApprovalRequest).toHaveBeenCalledTimes(1);
  });
});
