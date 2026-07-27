import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import * as client from "./api-client/client";

// Phase 16 items 1 and 7: the "Wie ben je?" screen, renamed "Welkom" and
// moved onto the shared centered Layout (same shell every other short screen
// uses -- see routes/Upload/NewWorkflowPage.tsx) instead of a bare, unstyled
// <main>/<h1>/<form>.
describe("App (Welkom screen)", () => {
  afterEach(() => {
    localStorage.clear();
    cleanup();
    vi.restoreAllMocks();
  });

  function renderApp() {
    return render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
  }

  it("shows the Welkom title and instructional text when there is no stored user", () => {
    renderApp();

    expect(screen.getByRole("heading", { level: 1, name: "Welkom" })).toBeInTheDocument();
    expect(screen.getByText("Vul je naam in om een nieuw gespreksverslag te starten.")).toBeInTheDocument();
  });

  it("renders through the shared centered Layout shell", () => {
    const { container } = renderApp();
    const main = container.querySelector("main");
    expect(main).toHaveClass("page", "page-centered");
    expect(main?.querySelector(".page-header h1")).toHaveTextContent("Welkom");
  });

  it("has a Naam and E-mailadres field, and a primary submit button disabled until both are filled", () => {
    renderApp();

    expect(screen.getByLabelText("Naam")).toBeInTheDocument();
    expect(screen.getByLabelText("E-mailadres")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Doorgaan" })).toBeDisabled();
  });

  // Phase 16 item 7: a stored user the backend no longer recognizes is
  // dropped silently at app load -- no error, no session-expired notice --
  // and the Welkom screen shows exactly as it would for a first-time visit.
  it("silently falls back to the Welkom screen when the stored user no longer exists server-side", async () => {
    localStorage.setItem("transcript-agent:currentUser", JSON.stringify({ id: "gone", name: "Jan", email: "jan@example.com" }));
    vi.spyOn(client, "getUser").mockRejectedValue(new client.ApiError(404, "User not found"));

    renderApp();

    expect(await screen.findByRole("heading", { level: 1, name: "Welkom" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
