import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as client from "../../api-client/client";
import { UploadScreen } from "./UploadScreen";

function workflow(overrides: Partial<client.Workflow> = {}): client.Workflow {
  return {
    id: "w1",
    title: "Kickoff meeting",
    currentState: "CREATED",
    reportType: null,
    status: "ACTIVE",
    createdById: "u1",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...overrides,
  };
}

function renderScreen(props: Partial<Parameters<typeof UploadScreen>[0]> = {}) {
  return render(
    <MemoryRouter>
      <UploadScreen workflow={workflow()} currentUserId="u1" onUpdated={vi.fn()} {...props} />
    </MemoryRouter>,
  );
}

describe("routes/Upload/UploadScreen", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("disables the submit button until transcript text is entered", () => {
    renderScreen();

    expect(screen.getByRole("button", { name: /Uploaden en indienen/ })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Transcript"), { target: { value: "Some transcript content" } });

    expect(screen.getByRole("button", { name: /Uploaden en indienen/ })).toBeEnabled();
  });

  it("uploads the transcript, then submits for validation, then calls onUpdated", async () => {
    const uploadTranscriptMock = vi.spyOn(client, "uploadTranscript").mockResolvedValue({});
    const submitForValidationMock = vi
      .spyOn(client, "submitForValidation")
      .mockResolvedValue(workflow({ currentState: "VALIDATING_TRANSCRIPT" }));
    const onUpdated = vi.fn();

    renderScreen({ onUpdated });

    fireEvent.change(screen.getByLabelText("Transcript"), { target: { value: "Some transcript content" } });
    fireEvent.click(screen.getByRole("button", { name: /Uploaden en indienen/ }));

    await waitFor(() => {
      expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ currentState: "VALIDATING_TRANSCRIPT" }));
    });

    expect(uploadTranscriptMock).toHaveBeenCalledWith("w1", { uploadedById: "u1", content: "Some transcript content" });
    expect(submitForValidationMock).toHaveBeenCalledWith("w1", { actorId: "u1" });

    const transcriptOrder = uploadTranscriptMock.mock.invocationCallOrder[0];
    const submitOrder = submitForValidationMock.mock.invocationCallOrder[0];
    expect(transcriptOrder).toBeLessThan(submitOrder);
  });

  it("in the TRANSCRIPT_UPLOADED resumption state, submits for validation without re-uploading", async () => {
    const submitForValidationMock = vi
      .spyOn(client, "submitForValidation")
      .mockResolvedValue(workflow({ currentState: "VALIDATING_TRANSCRIPT" }));
    const uploadTranscriptMock = vi.spyOn(client, "uploadTranscript");
    const onUpdated = vi.fn();

    renderScreen({ workflow: workflow({ currentState: "TRANSCRIPT_UPLOADED" }), onUpdated });

    fireEvent.click(screen.getByRole("button", { name: "Indienen voor validatie" }));

    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    expect(uploadTranscriptMock).not.toHaveBeenCalled();
    expect(submitForValidationMock).toHaveBeenCalledWith("w1", { actorId: "u1" });
  });

  it("shows a translated error message when submission fails", async () => {
    vi.spyOn(client, "uploadTranscript").mockRejectedValue(new Error("network down"));

    renderScreen();

    fireEvent.change(screen.getByLabelText("Transcript"), { target: { value: "Some transcript content" } });
    fireEvent.click(screen.getByRole("button", { name: /Uploaden en indienen/ }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Er is een fout opgetreden."));
  });

  it("extracts text from an uploaded .txt file into the transcript field", async () => {
    renderScreen();

    const file = new File(["Tekst uit bestand"], "transcript.txt", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Transcript als bestand uploaden"), { target: { files: [file] } });

    await waitFor(() => expect(screen.getByLabelText("Transcript")).toHaveValue("Tekst uit bestand"));
  });

  it("shows a Dutch error and does not populate the field when a .pdf file is uploaded", async () => {
    renderScreen();

    const file = new File(["%PDF-1.4"], "transcript.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Transcript als bestand uploaden"), { target: { files: [file] } });

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/PDF wordt nog niet ondersteund/));
    expect(screen.getByLabelText("Transcript")).toHaveValue("");
  });

  // Phase 19: CREATED is only reachable via the context step's
  // continue_to_transcript edge -- "back" here is a real back_to_context
  // transition (BackOrCancel mode="back-to-context"), not a local navigate().
  it("has a back-to-context control that moves the workflow back to CONTEXT_INPUT", async () => {
    const backToContextMock = vi
      .spyOn(client, "backToContext")
      .mockResolvedValue(workflow({ currentState: "CONTEXT_INPUT" }));
    const onUpdated = vi.fn();

    renderScreen({ onUpdated });

    fireEvent.click(screen.getByRole("button", { name: "Terug naar aanvullende context" }));

    await waitFor(() => expect(backToContextMock).toHaveBeenCalledWith("w1", { actorId: "u1" }));
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ currentState: "CONTEXT_INPUT" }));
  });

  it("the TRANSCRIPT_UPLOADED resumption screen still uses the plain local back control", () => {
    renderScreen({ workflow: workflow({ currentState: "TRANSCRIPT_UPLOADED" }) });
    expect(screen.getByRole("button", { name: "Terug naar begin" })).toBeInTheDocument();
  });
});
