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

  it("uploads the transcript, then notes, then submits for validation in order, then calls onUpdated", async () => {
    const uploadTranscriptMock = vi.spyOn(client, "uploadTranscript").mockResolvedValue({});
    const uploadNotesMock = vi.spyOn(client, "uploadNotes").mockResolvedValue({});
    const submitForValidationMock = vi
      .spyOn(client, "submitForValidation")
      .mockResolvedValue(workflow({ currentState: "VALIDATING_TRANSCRIPT" }));
    const onUpdated = vi.fn();

    renderScreen({ onUpdated });

    fireEvent.change(screen.getByLabelText("Transcript"), { target: { value: "Some transcript content" } });
    fireEvent.change(screen.getByLabelText("Notities (optioneel)"), { target: { value: "Some notes" } });
    fireEvent.click(screen.getByRole("button", { name: /Uploaden en indienen/ }));

    await waitFor(() => {
      expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ currentState: "VALIDATING_TRANSCRIPT" }));
    });

    expect(uploadTranscriptMock).toHaveBeenCalledWith("w1", { uploadedById: "u1", content: "Some transcript content" });
    expect(uploadNotesMock).toHaveBeenCalledWith("w1", { uploadedById: "u1", content: "Some notes" });
    expect(submitForValidationMock).toHaveBeenCalledWith("w1", { actorId: "u1" });

    const transcriptOrder = uploadTranscriptMock.mock.invocationCallOrder[0];
    const notesOrder = uploadNotesMock.mock.invocationCallOrder[0];
    const submitOrder = submitForValidationMock.mock.invocationCallOrder[0];
    expect(transcriptOrder).toBeLessThan(notesOrder);
    expect(notesOrder).toBeLessThan(submitOrder);
  });

  it("skips notes upload when the notes field is left empty", async () => {
    vi.spyOn(client, "uploadTranscript").mockResolvedValue({});
    const uploadNotesMock = vi.spyOn(client, "uploadNotes").mockResolvedValue({});
    vi.spyOn(client, "submitForValidation").mockResolvedValue(workflow({ currentState: "VALIDATING_TRANSCRIPT" }));

    renderScreen();

    fireEvent.change(screen.getByLabelText("Transcript"), { target: { value: "Some transcript content" } });
    fireEvent.click(screen.getByRole("button", { name: /Uploaden en indienen/ }));

    await waitFor(() => expect(client.submitForValidation).toHaveBeenCalled());
    expect(uploadNotesMock).not.toHaveBeenCalled();
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

  it("has a back control that does not call the backend", () => {
    renderScreen();
    expect(screen.getByRole("button", { name: "Terug naar begin" })).toBeInTheDocument();
  });
});
