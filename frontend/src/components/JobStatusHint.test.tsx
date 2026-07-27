import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as client from "../api-client/client";
import type { WorkflowJob } from "../api-client/client";
import { JobStatusHint } from "./JobStatusHint";

function job(overrides: Partial<WorkflowJob> = {}): WorkflowJob {
  return {
    id: "j1",
    workflowId: "w1",
    jobType: "GENERATE_DRAFT",
    status: "RUNNING",
    error: null,
    attemptCount: 1,
    createdAt: "2026-01-01",
    completedAt: null,
    ...overrides,
  };
}

describe("components/JobStatusHint", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows a Dutch explanation for a QUEUED job", async () => {
    vi.spyOn(client, "getLatestJob").mockResolvedValue(job({ status: "QUEUED" }));

    render(<JobStatusHint workflowId="w1" />);

    await screen.findByText(/In wachtrij/);
  });

  it("shows a Dutch explanation for a RUNNING job", async () => {
    vi.spyOn(client, "getLatestJob").mockResolvedValue(job({ status: "RUNNING" }));

    render(<JobStatusHint workflowId="w1" />);

    await screen.findByText(/Wordt op dit moment uitgevoerd/);
  });

  it("shows nothing once the job succeeded", async () => {
    vi.spyOn(client, "getLatestJob").mockResolvedValue(job({ status: "SUCCEEDED" }));

    const { container } = render(<JobStatusHint workflowId="w1" />);

    await waitFor(() => expect(client.getLatestJob).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("shows nothing when there is no job yet or the fetch fails", async () => {
    vi.spyOn(client, "getLatestJob").mockRejectedValue(new Error("boom"));

    const { container } = render(<JobStatusHint workflowId="w1" />);

    await waitFor(() => expect(client.getLatestJob).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
