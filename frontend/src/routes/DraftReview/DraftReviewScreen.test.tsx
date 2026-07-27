import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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

function renderScreen(props: Partial<Parameters<typeof DraftReviewScreen>[0]> = {}) {
  return render(
    <MemoryRouter>
      <DraftReviewScreen workflow={workflow()} currentUserId="u1" onUpdated={vi.fn()} {...props} />
    </MemoryRouter>,
  );
}

describe("routes/DraftReview/DraftReviewScreen", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders the draft header and every section", async () => {
    vi.spyOn(client, "getDrafts").mockResolvedValue([draft()]);

    renderScreen();

    await screen.findByText("Gespreksverslag Kickoff");
    expect(screen.getByText("Aanwezige deelnemers: Jan (voorzitter)")).toBeInTheDocument();
    expect(screen.getByText("Kernpunt A")).toBeInTheDocument();
    expect(screen.getByText("Detail B")).toBeInTheDocument();
  });

  it("renders an understandable Dutch precheck message listing missing sections, with no raw score or English text", async () => {
    vi.spyOn(client, "getDrafts").mockResolvedValue([
      draft({
        precheck: {
          id: "p1",
          overallScore: 0.5,
          checklist: [
            { item: "Notulen", passed: false },
            { item: "Samenvatting", passed: true },
          ],
          blockingIssues: ["Missing or empty required section: Notulen"],
          recommendation: "Draft is missing required content.",
          createdAt: "2026-01-01",
        },
      }),
    ]);

    renderScreen();

    await screen.findByText("Controle uitgevoerd: de volgende onderdelen ontbreken nog: Notulen.");
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    expect(screen.queryByText("Missing or empty required section: Notulen")).not.toBeInTheDocument();
    expect(screen.queryByText("Draft is missing required content.")).not.toBeInTheDocument();
  });

  it("renders the 'no issues' Dutch precheck message when there are no blocking issues", async () => {
    vi.spyOn(client, "getDrafts").mockResolvedValue([
      draft({
        precheck: {
          id: "p1",
          overallScore: 1,
          checklist: [{ item: "Notulen", passed: true }],
          blockingIssues: [],
          recommendation: "Looks complete.",
          createdAt: "2026-01-01",
        },
      }),
    ]);

    renderScreen();

    await screen.findByText("Controle uitgevoerd: het conceptverslag voldoet aan de basisstructuur.");
  });

  it("uses the latest draft version when multiple exist", async () => {
    vi.spyOn(client, "getDrafts").mockResolvedValue([draft({ version: 1, title: "V1" }), draft({ version: 2, title: "V2" })]);

    renderScreen();

    await screen.findByText("V2");
    expect(screen.queryByText("V1")).not.toBeInTheDocument();
  });

  it("approving calls reviewDraft with decision approve and calls onUpdated", async () => {
    vi.spyOn(client, "getDrafts").mockResolvedValue([draft()]);
    vi.spyOn(client, "reviewDraft").mockResolvedValue(workflow({ currentState: "GENERATING_FINAL" }));
    const onUpdated = vi.fn();

    renderScreen({ onUpdated });

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

    renderScreen({ onUpdated });

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

  it("shows a translated load error", async () => {
    vi.spyOn(client, "getDrafts").mockRejectedValue(new Error("boom"));

    renderScreen();

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Er is een fout opgetreden."));
  });

  it("offers a cancel control instead of a backward navigation edge", async () => {
    vi.spyOn(client, "getDrafts").mockResolvedValue([draft()]);

    renderScreen();

    expect(await screen.findByRole("button", { name: "Workflow annuleren" })).toBeInTheDocument();
  });
});
