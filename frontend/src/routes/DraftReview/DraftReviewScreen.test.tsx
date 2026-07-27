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

  // Phase 16 item 2: "Acties en vervolgstappen" must render as a real table
  // (the report prompts already ask the model for a markdown table -- see
  // ai/prompts/reportTypes/{thematic,qa}.md), not as one <p> per pipe-delimited
  // line.
  it("renders a markdown table section as a real <table>, with empty deadline cells left empty", async () => {
    vi.spyOn(client, "getDrafts").mockResolvedValue([
      draft({
        sections: [
          { heading: "Samenvatting", content: "Kernpunt A" },
          {
            heading: "Acties en vervolgstappen",
            content: "| Actie | Verantwoordelijke | Deadline | Status |\n|---|---|---|---|\n| Actie A | Jan |  | Open |",
          },
        ],
      }),
    ]);

    renderScreen();

    await screen.findByText("Acties en vervolgstappen");
    const table = screen.getByRole("table");
    expect(table).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Deadline" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Actie A" })).toBeInTheDocument();
    expect(screen.queryByText(/^\|/)).not.toBeInTheDocument();
    // The Deadline cell (between "Jan" and "Open") is empty, not a fabricated date.
    const cells = screen.getAllByRole("cell").map((cell) => cell.textContent);
    expect(cells).toEqual(["Actie A", "Jan", "", "Open"]);
  });

  // Phase 15 item 2: a passing item must never read as missing just because
  // it was bundled with something that failed -- every checklist item is
  // rendered on its own, with its own ✓/⚠ marker.
  it("renders every checklist item with its own pass/fail marker, with no raw score or English text", async () => {
    vi.spyOn(client, "getDrafts").mockResolvedValue([
      draft({
        precheck: {
          id: "p1",
          overallScore: 0.8,
          checklist: [
            { item: "Deelnemers correct overgenomen", passed: true },
            { item: "Datum ontbreekt", passed: false },
            { item: "Onderwerp correct overgenomen", passed: true },
            { item: "Structuur voldoet", passed: true },
            { item: "Inhoud sluit aan op het transcript", passed: true },
          ],
          blockingIssues: ["Datum ontbreekt."],
          recommendation: "1 aandachtspunt(en) gevonden -- controleer de checklist voor details.",
          createdAt: "2026-01-01",
        },
      }),
    ]);

    renderScreen();

    await screen.findByText("Kwaliteitscontrole");
    expect(screen.getByText("✓ Deelnemers correct overgenomen")).toBeInTheDocument();
    expect(screen.getByText("✓ Onderwerp correct overgenomen")).toBeInTheDocument();
    expect(screen.getByText("✓ Structuur voldoet")).toBeInTheDocument();
    expect(screen.getByText("✓ Inhoud sluit aan op het transcript")).toBeInTheDocument();
    expect(screen.getByText("⚠ Datum ontbreekt")).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    expect(screen.queryByText(/aandachtspunt/)).not.toBeInTheDocument();
  });

  it("renders every item with a ✓ marker when all checks pass", async () => {
    vi.spyOn(client, "getDrafts").mockResolvedValue([
      draft({
        precheck: {
          id: "p1",
          overallScore: 1,
          checklist: [
            { item: "Deelnemers correct overgenomen", passed: true },
            { item: "Datum correct overgenomen", passed: true },
            { item: "Onderwerp correct overgenomen", passed: true },
            { item: "Structuur voldoet", passed: true },
            { item: "Inhoud sluit aan op het transcript", passed: true },
          ],
          blockingIssues: [],
          recommendation: "Alle controles geslaagd -- geen aandachtspunten gevonden.",
          createdAt: "2026-01-01",
        },
      }),
    ]);

    renderScreen();

    await screen.findByText("Kwaliteitscontrole");
    expect(screen.getByText("✓ Deelnemers correct overgenomen")).toBeInTheDocument();
    expect(screen.getByText("✓ Datum correct overgenomen")).toBeInTheDocument();
    expect(screen.getByText("✓ Onderwerp correct overgenomen")).toBeInTheDocument();
    expect(screen.getByText("✓ Structuur voldoet")).toBeInTheDocument();
    expect(screen.getByText("✓ Inhoud sluit aan op het transcript")).toBeInTheDocument();
    expect(screen.queryByText("⚠", { exact: false })).not.toBeInTheDocument();
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
