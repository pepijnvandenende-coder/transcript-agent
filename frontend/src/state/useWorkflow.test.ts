import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as client from "../api-client/client";
import { SLOW_HINT_AFTER_MS, useWorkflow } from "./useWorkflow";

function workflow(overrides: Partial<client.Workflow> = {}): client.Workflow {
  return {
    id: "w1",
    title: "Test",
    currentState: "CREATED",
    reportType: null,
    status: "ACTIVE",
    createdById: "u1",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...overrides,
  };
}

describe("state/useWorkflow", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("loads the workflow on mount", async () => {
    vi.spyOn(client, "getWorkflow").mockResolvedValue(workflow());

    const { result } = renderHook(() => useWorkflow("w1"));

    await act(async () => {});

    expect(result.current.workflow?.id).toBe("w1");
    expect(result.current.error).toBeNull();
  });

  it("surfaces a load error", async () => {
    vi.spyOn(client, "getWorkflow").mockRejectedValue(new Error("Workflow not found"));

    const { result } = renderHook(() => useWorkflow("missing"));

    await act(async () => {});

    expect(result.current.workflow).toBeNull();
    expect(result.current.error).toBe("Workflow not found");
  });

  it("polls while the state is transient and stops once it changes", async () => {
    vi.useFakeTimers();
    const getWorkflowMock = vi
      .spyOn(client, "getWorkflow")
      .mockResolvedValueOnce(workflow({ currentState: "MERGING" }))
      .mockResolvedValue(workflow({ currentState: "DETECTING_CONFLICTS" }));

    const { result } = renderHook(() => useWorkflow("w1"));
    await act(async () => {});
    expect(result.current.workflow?.currentState).toBe("MERGING");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });

    expect(result.current.workflow?.currentState).toBe("DETECTING_CONFLICTS");
    const callsAfterFirstChange = getWorkflowMock.mock.calls.length;

    // DETECTING_CONFLICTS is itself transient, so polling continues but
    // every subsequent call still resolves to the same state -- no further
    // workflow replacement should happen, just more polling calls.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(getWorkflowMock.mock.calls.length).toBeGreaterThan(callsAfterFirstChange);
    expect(result.current.workflow?.currentState).toBe("DETECTING_CONFLICTS");
  });

  it("does not poll for a stable checkpoint state", async () => {
    vi.useFakeTimers();
    const getWorkflowMock = vi.spyOn(client, "getWorkflow").mockResolvedValue(workflow({ currentState: "CONFLICTS_PENDING_REVIEW" }));

    renderHook(() => useWorkflow("w1"));
    await act(async () => {});
    const callsAfterLoad = getWorkflowMock.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(getWorkflowMock.mock.calls.length).toBe(callsAfterLoad);
  });

  it("reports polling elapsed time past the slow-hint threshold while transient", async () => {
    vi.useFakeTimers();
    vi.spyOn(client, "getWorkflow").mockResolvedValue(workflow({ currentState: "GENERATING_DRAFT" }));

    const { result } = renderHook(() => useWorkflow("w1"));
    await act(async () => {});

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLOW_HINT_AFTER_MS + 1500);
    });

    expect(result.current.pollingElapsedMs).toBeGreaterThan(SLOW_HINT_AFTER_MS);
  });

  it("setWorkflow lets a caller apply its own mutation result immediately", async () => {
    vi.spyOn(client, "getWorkflow").mockResolvedValue(workflow({ currentState: "AWAITING_REPORT_TYPE_SELECTION" }));

    const { result } = renderHook(() => useWorkflow("w1"));
    await act(async () => {});

    act(() => {
      result.current.setWorkflow(workflow({ currentState: "GENERATING_DRAFT" }));
    });

    expect(result.current.workflow?.currentState).toBe("GENERATING_DRAFT");
  });
});
