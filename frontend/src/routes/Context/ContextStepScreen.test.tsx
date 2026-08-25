import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as client from "../../api-client/client";
import { ContextStepScreen } from "./ContextStepScreen";

const navigateMock = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigateMock };
});

function workflow(overrides: Partial<client.Workflow> = {}): client.Workflow {
  return {
    id: "w1",
    title: "Kickoff meeting",
    currentState: "CONTEXT_INPUT",
    reportType: null,
    status: "ACTIVE",
    createdById: "u1",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...overrides,
  };
}

const CONTEXT_POLICIES: client.ContextTypePolicy[] = [
  { key: "pva", displayName: "Plan van Aanpak (PvA)", description: "Het plan van aanpak." },
  { key: "normenkader", displayName: "Normenkader", description: null },
];

function renderScreen(props: Partial<Parameters<typeof ContextStepScreen>[0]> = {}) {
  return render(
    <MemoryRouter>
      <ContextStepScreen workflow={workflow()} currentUserId="u1" onUpdated={vi.fn()} {...props} />
    </MemoryRouter>,
  );
}

describe("routes/Context/ContextStepScreen", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    navigateMock.mockClear();
  });

  it("renders a notes field and one optional field per active context type", async () => {
    vi.spyOn(client, "getContextTypePolicies").mockResolvedValue(CONTEXT_POLICIES);
    renderScreen();

    expect(screen.getByLabelText("Notities (optioneel)")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Plan van Aanpak (PvA) (optioneel)")).toBeInTheDocument());
    expect(screen.getByLabelText("Normenkader (optioneel)")).toBeInTheDocument();
  });

  it("continues to the transcript step with nothing filled in at all", async () => {
    vi.spyOn(client, "getContextTypePolicies").mockResolvedValue(CONTEXT_POLICIES);
    const uploadNotesMock = vi.spyOn(client, "uploadNotes").mockResolvedValue({});
    const uploadContextMock = vi.spyOn(client, "uploadContext").mockResolvedValue({});
    const continueToTranscriptMock = vi
      .spyOn(client, "continueToTranscript")
      .mockResolvedValue(workflow({ currentState: "CREATED" }));
    const onUpdated = vi.fn();

    renderScreen({ onUpdated });
    await waitFor(() => expect(screen.getByLabelText("Plan van Aanpak (PvA) (optioneel)")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Doorgaan naar transcript" }));

    await waitFor(() => expect(continueToTranscriptMock).toHaveBeenCalledWith("w1", { actorId: "u1" }));
    expect(uploadNotesMock).not.toHaveBeenCalled();
    expect(uploadContextMock).not.toHaveBeenCalled();
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ currentState: "CREATED" }));
  });

  it("uploads notes and only the filled-in context types, then continues to the transcript step, in order", async () => {
    vi.spyOn(client, "getContextTypePolicies").mockResolvedValue(CONTEXT_POLICIES);
    const uploadNotesMock = vi.spyOn(client, "uploadNotes").mockResolvedValue({});
    const uploadContextMock = vi.spyOn(client, "uploadContext").mockResolvedValue({});
    const continueToTranscriptMock = vi
      .spyOn(client, "continueToTranscript")
      .mockResolvedValue(workflow({ currentState: "CREATED" }));

    renderScreen();
    await waitFor(() => expect(screen.getByLabelText("Plan van Aanpak (PvA) (optioneel)")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Notities (optioneel)"), { target: { value: "Some notes" } });
    fireEvent.change(screen.getByLabelText("Plan van Aanpak (PvA) (optioneel)"), { target: { value: "PvA inhoud" } });
    // Normenkader deliberately left empty -- context is optional per type.
    fireEvent.click(screen.getByRole("button", { name: "Doorgaan naar transcript" }));

    await waitFor(() => expect(continueToTranscriptMock).toHaveBeenCalled());

    expect(uploadNotesMock).toHaveBeenCalledWith("w1", { uploadedById: "u1", content: "Some notes" });
    expect(uploadContextMock).toHaveBeenCalledTimes(1);
    expect(uploadContextMock).toHaveBeenCalledWith("w1", { uploadedById: "u1", contextType: "pva", content: "PvA inhoud" });

    const notesOrder = uploadNotesMock.mock.invocationCallOrder[0];
    const contextOrder = uploadContextMock.mock.invocationCallOrder[0];
    const continueOrder = continueToTranscriptMock.mock.invocationCallOrder[0];
    expect(notesOrder).toBeLessThan(contextOrder);
    expect(contextOrder).toBeLessThan(continueOrder);
  });

  it("shows only the notes field (no catalog-driven context fields) when the context type catalog is empty", async () => {
    vi.spyOn(client, "getContextTypePolicies").mockResolvedValue([]);
    renderScreen();

    await waitFor(() => expect(client.getContextTypePolicies).toHaveBeenCalled());
    expect(screen.getByLabelText("Notities (optioneel)")).toBeInTheDocument();
    expect(screen.queryByLabelText("Plan van Aanpak (PvA) (optioneel)")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Normenkader (optioneel)")).not.toBeInTheDocument();
  });

  it("shows a translated error message when continuing fails", async () => {
    vi.spyOn(client, "getContextTypePolicies").mockResolvedValue([]);
    vi.spyOn(client, "continueToTranscript").mockRejectedValue(new Error("network down"));

    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: "Doorgaan naar transcript" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Er is een fout opgetreden."));
  });

  it("has a back control that navigates home without calling the backend", () => {
    vi.spyOn(client, "getContextTypePolicies").mockResolvedValue([]);
    const continueToTranscriptMock = vi.spyOn(client, "continueToTranscript");

    renderScreen();

    fireEvent.click(screen.getByRole("button", { name: "Terug naar begin" }));

    expect(navigateMock).toHaveBeenCalledWith("/");
    expect(continueToTranscriptMock).not.toHaveBeenCalled();
  });
});
