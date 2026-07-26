import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Draft, Workflow } from "../../api-client/client";
import * as client from "../../api-client/client";
import { DraftReviewScreen } from "./DraftReviewScreen";

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: "w1",
    title: "Test",
    currentState: "DRAFT_PENDING_REVIEW",
    reportType: "thematic",
    status: "ACTIVE",
    createdById: "u1",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...overrides,
  };
}

function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: "d1",
    workflowId: "w1",
    version: 1,
    aiOutputId: "a1",
    reportType: "thematic",
    title: "Gespreksverslag Kickoff",
    attendees: ["Jan (voorzitter)"],
    date: "2026-01-01",
    subject: "Kickoff",
    sections: [
      { heading: "Samenvatting", content: "Kernpunt A" },
      { heading: "Notulen", content: "Detail B" },
    ],
    coverage: 0.7,
    createdAt: "2026-01-01",
    precheck: null,
    ...overrides,
  };
}

describe("routes/DraftReview/DraftReviewScreen", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the draft header and every section", async () => {
    vi.spyOn(client, "getDrafts").mockResolvedValue([draft()]);

    render(<DraftReviewScreen workflow={workflow()} currentUserId="u1" onUpdated={vi.fn()} />);

    await screen.findByText("Gespreksverslag Kickoff");
    expect(screen.getByText("Aanwezige deelnemers: Jan (voorzitter)")).toBeInTheDocument();
    expect(screen.getByText("Kernpunt A")).toBeInTheDocument();
    expect(screen.getByText("Detail B")).toBeInTheDocument();
  });

  it("renders the precheck banner with blocking issues when present", async () => {
    vi.spyOn(client, "getDrafts").mockResolvedValue([
      draft({
        precheck: {
          id: "p1",
          overallScore: 0.5,
          checklist: [{ item: "Notulen", passed: false }],
          blockingIssues: ["Missing or empty required section: Notulen"],
          recommendation: "Draft is missing required content.",
          createdAt: "2026-01-01",
        },
      }),
    ]);

    render(<DraftReviewScreen workflow={workflow()} currentUserId="u1" onUpdated={vi.fn()} />);

    await screen.findByText("Kwaliteitscontrole: 50%");
    expect(screen.getByText("Missing or empty required section: Notulen")).toBeInTheDocument();
    expect(screen.getByText("Draft is missing required content.")).toBeInTheDocument();
  });

  it("uses the latest draft version when multiple exist", async () => {
    vi.spyOn(client, "getDrafts").mockResolvedValue([draft({ version: 1, title: "V1" }), draft({ version: 2, title: "V2" })]);

    render(<DraftReviewScreen workflow={workflow()} currentUserId="u1" onUpdated={vi.fn()} />);

    await screen.findByText("V2");
    expect(screen.queryByText("V1")).not.toBeInTheDocument();
  });

  it("approving calls reviewDraft with decision approve and calls onUpdated", async () => {
    vi.spyOn(client, "getDrafts").mockResolvedValue([draft()]);
    vi.spyOn(client, "reviewDraft").mockResolvedValue(workflow({ currentState: "GENERATING_FINAL" }));
    const onUpdated = vi.fn();

    render(<DraftReviewScreen workflow={workflow()} currentUserId="u1" onUpdated={onUpdated} />);

    fireEvent.click(await screen.findByRole("button", { name: "Goedkeuren" }));

    await waitFor(() =>
      expect(client.reviewDraft).toHaveBeenCalledWith("w1", 1, { actorId: "u1", decision: "approve" }),
    );
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ currentState: "GENERATING_FINAL" }));
  });

  it("requesting changes is disabled until feedback is entered, and submits it", async () => {
    vi.spyOn(client, "getDrafts").mockResolvedValue([draft()]);
    vi.spyOn(client, "reviewDraft").mockResolvedValue(workflow({ currentState: "REVISING_DRAFT" }));
    const onUpdated = vi.fn();

    render(<DraftReviewScreen workflow={workflow()} currentUserId="u1" onUpdated={onUpdated} />);

    await screen.findByText("Gespreksverslag Kickoff");
    expect(screen.getByRole("button", { name: "Wijzigingen aanvragen" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Feedback voor wijzigingen"), { target: { value: "Voeg meer detail toe." } });
    fireEvent.click(screen.getByRole("button", { name: "Wijzigingen aanvragen" }));

    await waitFor(() =>
      expect(client.reviewDraft).toHaveBeenCalledWith("w1", 1, {
        actorId: "u1",
        decision: "request_changes",
        feedback: "Voeg meer detail toe.",
      }),
    );
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ currentState: "REVISING_DRAFT" }));
  });

  it("shows a load error", async () => {
    vi.spyOn(client, "getDrafts").mockRejectedValue(new Error("Server fout"));

    render(<DraftReviewScreen workflow={workflow()} currentUserId="u1" onUpdated={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Server fout"));
  });
});
