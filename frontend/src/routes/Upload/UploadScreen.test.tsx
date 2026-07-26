import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("routes/Upload/UploadScreen", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("disables the submit button until transcript text is entered", () => {
    render(<UploadScreen workflow={workflow()} currentUserId="u1" onUpdated={vi.fn()} />);

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

    render(<UploadScreen workflow={workflow()} currentUserId="u1" onUpdated={onUpdated} />);

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

    render(<UploadScreen workflow={workflow()} currentUserId="u1" onUpdated={vi.fn()} />);

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

    render(<UploadScreen workflow={workflow({ currentState: "TRANSCRIPT_UPLOADED" })} currentUserId="u1" onUpdated={onUpdated} />);

    fireEvent.click(screen.getByRole("button", { name: "Indienen voor validatie" }));

    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    expect(uploadTranscriptMock).not.toHaveBeenCalled();
    expect(submitForValidationMock).toHaveBeenCalledWith("w1", { actorId: "u1" });
  });

  it("shows an error message when submission fails", async () => {
    vi.spyOn(client, "uploadTranscript").mockRejectedValue(new Error("Netwerkfout"));

    render(<UploadScreen workflow={workflow()} currentUserId="u1" onUpdated={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Transcript"), { target: { value: "Some transcript content" } });
    fireEvent.click(screen.getByRole("button", { name: /Uploaden en indienen/ }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Netwerkfout"));
  });
});
