import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workflow, WorkflowJob } from "../../api-client/client";
import * as client from "../../api-client/client";
import { FailedScreen } from "./FailedScreen";

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "w1",
    title: "Test",
    currentState: "FAILED",
    reportType: null,
    status: "ACTIVE",
    createdById: "u1",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...overrides,
  };
}

function job(overrides: Partial<WorkflowJob> = {}): WorkflowJob {
  return {
    id: "j1",
    workflowId: "w1",
    jobType: "GENERATE_DRAFT",
    status: "FAILED",
    error: "Missing required environment variable: ANTHROPIC_API_KEY",
    attemptCount: 1,
    createdAt: "2026-01-01",
    completedAt: "2026-01-01",
    ...overrides,
  };
}

function renderScreen(props: Partial<Parameters<typeof FailedScreen>[0]> = {}) {
  return render(<FailedScreen workflow={workflow()} currentUserId="u1" onUpdated={vi.fn()} {...props} />);
}

describe("routes/Failed/FailedScreen", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows a translated explanation of the job's error, never the raw English text", async () => {
    vi.spyOn(client, "getLatestJob").mockResolvedValue(job());

    renderScreen();

    await screen.findByText(/AI-koppeling/);
    expect(screen.queryByText(/ANTHROPIC_API_KEY/)).not.toBeInTheDocument();
  });

  it("offers a retry action that calls retryFailedJob and applies the result via onUpdated", async () => {
    vi.spyOn(client, "getLatestJob").mockResolvedValue(job());
    vi.spyOn(client, "retryFailedJob").mockResolvedValue(workflow({ currentState: "GENERATING_DRAFT" }));
    const onUpdated = vi.fn();

    renderScreen({ onUpdated });

    fireEvent.click(await screen.findByRole("button", { name: "Opnieuw proberen" }));

    await waitFor(() => expect(client.retryFailedJob).toHaveBeenCalledWith("w1", { actorId: "u1" }));
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ currentState: "GENERATING_DRAFT" }));
  });

  it("shows a translated error when retry fails", async () => {
    vi.spyOn(client, "getLatestJob").mockResolvedValue(job());
    vi.spyOn(client, "retryFailedJob").mockRejectedValue(new Error("boom"));

    renderScreen();

    fireEvent.click(await screen.findByRole("button", { name: "Opnieuw proberen" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Er is een fout opgetreden."));
  });

  it("still offers retry even if the job fetch itself fails", async () => {
    vi.spyOn(client, "getLatestJob").mockRejectedValue(new Error("boom"));

    renderScreen();

    expect(await screen.findByRole("button", { name: "Opnieuw proberen" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Er is een fout opgetreden.");
  });
});
