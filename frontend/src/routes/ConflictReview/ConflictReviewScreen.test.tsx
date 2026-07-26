import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as client from "../../api-client/client";
import { ConflictReviewScreen } from "./ConflictReviewScreen";

function workflow(overrides: Partial<client.Workflow> = {}): client.Workflow {
  return {
    id: "w1",
    title: "Test",
    currentState: "CONFLICTS_PENDING_REVIEW",
    reportType: null,
    status: "ACTIVE",
    createdById: "u1",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...overrides,
  };
}

function conflict(overrides: Partial<client.Conflict> = {}): client.Conflict {
  return {
    id: "c1",
    workflowId: "w1",
    aiOutputId: "a1",
    description: "Datum komt niet overeen",
    sourceA: "12 januari",
    sourceB: "13 januari",
    status: "OPEN",
    resolution: null,
    resolvedById: null,
    resolvedAt: null,
    createdAt: "2026-01-01",
    ...overrides,
  };
}

describe("routes/ConflictReview/ConflictReviewScreen", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders open conflicts with their sources", async () => {
    vi.spyOn(client, "getConflicts").mockResolvedValue([conflict()]);

    render(<ConflictReviewScreen workflow={workflow()} currentUserId="u1" onUpdated={vi.fn()} />);

    await screen.findByText("Datum komt niet overeen");
    expect(screen.getByText("12 januari")).toBeInTheDocument();
    expect(screen.getByText("13 januari")).toBeInTheDocument();
  });

  it("renders resolved conflicts read-only, with their resolution text", async () => {
    vi.spyOn(client, "getConflicts").mockResolvedValue([
      conflict({ id: "c2", status: "RESOLVED", resolution: "Bevestigd via e-mail" }),
    ]);

    render(<ConflictReviewScreen workflow={workflow()} currentUserId="u1" onUpdated={vi.fn()} />);

    await screen.findByText(/Bevestigd via e-mail/);
    expect(screen.getByText("Geen openstaande conflicten.")).toBeInTheDocument();
  });

  it("disables Verklaren until an explanation is entered", async () => {
    vi.spyOn(client, "getConflicts").mockResolvedValue([conflict()]);

    render(<ConflictReviewScreen workflow={workflow()} currentUserId="u1" onUpdated={vi.fn()} />);

    await screen.findByText("Datum komt niet overeen");
    expect(screen.getByRole("button", { name: "Verklaren" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Toelichting"), { target: { value: "De 13e is correct." } });

    expect(screen.getByRole("button", { name: "Verklaren" })).toBeEnabled();
  });

  it("when a resolved conflict still leaves others open, refetches instead of calling onUpdated", async () => {
    const getConflictsMock = vi
      .spyOn(client, "getConflicts")
      .mockResolvedValueOnce([conflict()])
      .mockResolvedValueOnce([conflict({ status: "RESOLVED", resolution: "De 13e is correct." })]);
    vi.spyOn(client, "explainConflict").mockResolvedValue({ conflict: conflict({ status: "RESOLVED" }), workflow: null });
    const onUpdated = vi.fn();

    render(<ConflictReviewScreen workflow={workflow()} currentUserId="u1" onUpdated={onUpdated} />);

    await screen.findByText("Datum komt niet overeen");
    fireEvent.change(screen.getByLabelText("Toelichting"), { target: { value: "De 13e is correct." } });
    fireEvent.click(screen.getByRole("button", { name: "Verklaren" }));

    await waitFor(() => expect(getConflictsMock).toHaveBeenCalledTimes(2));
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it("when the last open conflict is resolved, calls onUpdated with the advanced workflow", async () => {
    vi.spyOn(client, "getConflicts").mockResolvedValue([conflict()]);
    vi.spyOn(client, "explainConflict").mockResolvedValue({
      conflict: conflict({ status: "RESOLVED" }),
      workflow: workflow({ currentState: "MERGING" }),
    });
    const onUpdated = vi.fn();

    render(<ConflictReviewScreen workflow={workflow()} currentUserId="u1" onUpdated={onUpdated} />);

    await screen.findByText("Datum komt niet overeen");
    fireEvent.change(screen.getByLabelText("Toelichting"), { target: { value: "De 13e is correct." } });
    fireEvent.click(screen.getByRole("button", { name: "Verklaren" }));

    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ currentState: "MERGING" })));
  });

  it("restarting the upload calls restartUpload and onUpdated", async () => {
    vi.spyOn(client, "getConflicts").mockResolvedValue([conflict()]);
    vi.spyOn(client, "restartUpload").mockResolvedValue(workflow({ currentState: "TRANSCRIPT_UPLOADED" }));
    const onUpdated = vi.fn();

    render(<ConflictReviewScreen workflow={workflow()} currentUserId="u1" onUpdated={onUpdated} />);

    await screen.findByText("Datum komt niet overeen");
    fireEvent.click(screen.getByRole("button", { name: "Upload opnieuw starten" }));

    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ currentState: "TRANSCRIPT_UPLOADED" })));
    expect(client.restartUpload).toHaveBeenCalledWith("w1", { actorId: "u1" });
  });
});
