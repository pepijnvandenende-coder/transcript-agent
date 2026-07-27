import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as client from "../../api-client/client";
import { NewWorkflowPage } from "./NewWorkflowPage";

const navigateMock = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigateMock };
});

describe("routes/Upload/NewWorkflowPage", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    navigateMock.mockClear();
  });

  // Phase 16 item 1: exact requested copy.
  it("shows the requested heading and instructional intro text", () => {
    render(
      <MemoryRouter>
        <NewWorkflowPage currentUserId="u1" />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Voor welke vergadering wil je een gespreksverslag genereren?" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Vul de naam of het onderwerp van de vergadering in. Vervolgens upload je het transcript en eventueel aanvullende notities.",
      ),
    ).toBeInTheDocument();
  });

  it("disables the submit button until a title is entered", () => {
    render(
      <MemoryRouter>
        <NewWorkflowPage currentUserId="u1" />
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "Gespreksverslag starten" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Naam van de vergadering"), { target: { value: "Kickoff meeting" } });

    expect(screen.getByRole("button", { name: "Gespreksverslag starten" })).toBeEnabled();
  });

  it("creates the workflow with the current user and navigates to its detail page", async () => {
    vi.spyOn(client, "createWorkflow").mockResolvedValue({
      id: "w1",
      title: "Kickoff meeting",
      currentState: "CREATED",
      reportType: null,
      status: "ACTIVE",
      createdById: "u1",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    });

    render(
      <MemoryRouter>
        <NewWorkflowPage currentUserId="u1" />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("Naam van de vergadering"), { target: { value: "Kickoff meeting" } });
    fireEvent.click(screen.getByRole("button", { name: "Gespreksverslag starten" }));

    await waitFor(() => {
      expect(client.createWorkflow).toHaveBeenCalledWith({ title: "Kickoff meeting", createdById: "u1" });
      expect(navigateMock).toHaveBeenCalledWith("/workflows/w1");
    });
  });
});
