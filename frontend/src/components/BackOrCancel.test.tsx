import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as client from "../api-client/client";
import { BackOrCancel } from "./BackOrCancel";

const navigateMock = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigateMock };
});

function workflow(overrides: Partial<client.Workflow> = {}): client.Workflow {
  return {
    id: "w1",
    title: "Test",
    currentState: "CANCELLED",
    reportType: null,
    status: "CANCELLED",
    createdById: "u1",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...overrides,
  };
}

describe("components/BackOrCancel", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    navigateMock.mockClear();
  });

  it("mode=back navigates to the start without calling the backend", () => {
    const cancelWorkflowMock = vi.spyOn(client, "cancelWorkflow");
    render(
      <MemoryRouter>
        <BackOrCancel mode="back" />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Terug naar begin" }));

    expect(navigateMock).toHaveBeenCalledWith("/");
    expect(cancelWorkflowMock).not.toHaveBeenCalled();
  });

  it("mode=cancel requires an explicit confirmation before calling cancelWorkflow", async () => {
    const cancelWorkflowMock = vi.spyOn(client, "cancelWorkflow").mockResolvedValue(workflow());
    const onCancelled = vi.fn();

    render(
      <MemoryRouter>
        <BackOrCancel mode="cancel" workflowId="w1" currentUserId="u1" onCancelled={onCancelled} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Workflow annuleren" }));
    expect(cancelWorkflowMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Ja, annuleren" }));

    await waitFor(() => expect(cancelWorkflowMock).toHaveBeenCalledWith("w1", { actorId: "u1" }));
    expect(onCancelled).toHaveBeenCalledWith(expect.objectContaining({ currentState: "CANCELLED" }));
  });

  it("mode=cancel lets the user back out of the confirmation without cancelling", () => {
    const cancelWorkflowMock = vi.spyOn(client, "cancelWorkflow");

    render(
      <MemoryRouter>
        <BackOrCancel mode="cancel" workflowId="w1" currentUserId="u1" onCancelled={vi.fn()} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Workflow annuleren" }));
    fireEvent.click(screen.getByRole("button", { name: "Nee, doorgaan" }));

    expect(screen.getByRole("button", { name: "Workflow annuleren" })).toBeInTheDocument();
    expect(cancelWorkflowMock).not.toHaveBeenCalled();
  });

  it("shows a translated error if cancelling fails", async () => {
    vi.spyOn(client, "cancelWorkflow").mockRejectedValue(new Error("network down"));

    render(
      <MemoryRouter>
        <BackOrCancel mode="cancel" workflowId="w1" currentUserId="u1" onCancelled={vi.fn()} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Workflow annuleren" }));
    fireEvent.click(screen.getByRole("button", { name: "Ja, annuleren" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Er is een fout opgetreden."));
  });
});
