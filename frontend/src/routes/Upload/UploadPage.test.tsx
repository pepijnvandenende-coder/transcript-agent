import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as client from "../../api-client/client";
import { UploadPage } from "./UploadPage";

function renderAtWorkflow(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/workflows/${id}`]}>
      <Routes>
        <Route path="/workflows/:id" element={<UploadPage currentUserId="u1" />} />
      </Routes>
    </MemoryRouter>,
  );
}

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

describe("routes/Upload/UploadPage", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("disables the submit button until transcript text is entered", async () => {
    vi.spyOn(client, "getWorkflow").mockResolvedValue(workflow());

    renderAtWorkflow("w1");

    await screen.findByLabelText("Transcript");
    expect(screen.getByRole("button", { name: /Uploaden en indienen/ })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Transcript"), { target: { value: "Some transcript content" } });

    expect(screen.getByRole("button", { name: /Uploaden en indienen/ })).toBeEnabled();
  });

  it("uploads the transcript, then notes, then submits for validation in order", async () => {
    vi.spyOn(client, "getWorkflow").mockResolvedValue(workflow());
    const uploadTranscriptMock = vi.spyOn(client, "uploadTranscript").mockResolvedValue({});
    const uploadNotesMock = vi.spyOn(client, "uploadNotes").mockResolvedValue({});
    const submitForValidationMock = vi
      .spyOn(client, "submitForValidation")
      .mockResolvedValue(workflow({ currentState: "VALIDATING_TRANSCRIPT" }));

    renderAtWorkflow("w1");

    await screen.findByLabelText("Transcript");
    fireEvent.change(screen.getByLabelText("Transcript"), { target: { value: "Some transcript content" } });
    fireEvent.change(screen.getByLabelText("Notities (optioneel)"), { target: { value: "Some notes" } });
    fireEvent.click(screen.getByRole("button", { name: /Uploaden en indienen/ }));

    await waitFor(() => {
      expect(uploadTranscriptMock).toHaveBeenCalledWith("w1", { uploadedById: "u1", content: "Some transcript content" });
      expect(uploadNotesMock).toHaveBeenCalledWith("w1", { uploadedById: "u1", content: "Some notes" });
      expect(submitForValidationMock).toHaveBeenCalledWith("w1", { actorId: "u1" });
    });

    const transcriptOrder = uploadTranscriptMock.mock.invocationCallOrder[0];
    const notesOrder = uploadNotesMock.mock.invocationCallOrder[0];
    const submitOrder = submitForValidationMock.mock.invocationCallOrder[0];
    expect(transcriptOrder).toBeLessThan(notesOrder);
    expect(notesOrder).toBeLessThan(submitOrder);
  });

  it("shows a 'is the worker running?' hint after prolonged polling in VALIDATING_TRANSCRIPT", async () => {
    // Fake timers must be active *before* render, so the polling effect's
    // setInterval is registered against the faked clock from the start --
    // enabling them after mount wouldn't retroactively convert an
    // already-scheduled real interval.
    vi.useFakeTimers();
    vi.spyOn(client, "getWorkflow").mockResolvedValue(workflow({ currentState: "VALIDATING_TRANSCRIPT" }));

    renderAtWorkflow("w1");

    // Flushes the initial getWorkflow().then(setWorkflow) microtask (fake
    // timers only fake setTimeout/setInterval/Date, not Promise scheduling).
    await act(async () => {});

    expect(screen.queryByText(/Draait de worker/)).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });

    expect(screen.getByText(/Draait de worker/)).toBeInTheDocument();
  });
});
