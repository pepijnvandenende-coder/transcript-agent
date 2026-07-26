import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatusBadge } from "./StatusBadge";

describe("components/StatusBadge", () => {
  afterEach(cleanup);

  it("renders a plain-language label for a processing state", () => {
    render(<StatusBadge state="VALIDATING_TRANSCRIPT" />);
    expect(screen.getByText("Transcript wordt gevalideerd...")).toBeInTheDocument();
  });

  it("renders a plain-language label for a state needing attention", () => {
    render(<StatusBadge state="PENDING_HUMAN_CONFIRMATION" />);
    expect(screen.getByText("Wacht op menselijke bevestiging")).toBeInTheDocument();
  });

  it("renders a plain-language label for the terminal COMPLETED state", () => {
    render(<StatusBadge state="COMPLETED" />);
    expect(screen.getByText("Voltooid")).toBeInTheDocument();
  });

  it("renders a label for every WorkflowState value without throwing", () => {
    const allStates: Array<Parameters<typeof StatusBadge>[0]["state"]> = [
      "CREATED",
      "TRANSCRIPT_UPLOADED",
      "VALIDATING_TRANSCRIPT",
      "TRANSCRIPT_INSUFFICIENT",
      "PENDING_HUMAN_CONFIRMATION",
      "MERGING",
      "DETECTING_CONFLICTS",
      "CONFLICTS_PENDING_REVIEW",
      "SUGGESTING_REPORT_TYPE",
      "AWAITING_REPORT_TYPE_SELECTION",
      "GENERATING_DRAFT",
      "DRAFT_QUALITY_PRECHECK",
      "DRAFT_PENDING_REVIEW",
      "REVISING_DRAFT",
      "GENERATING_FINAL",
      "COMPLETED",
      "CANCELLED",
      "FAILED",
    ];
    for (const state of allStates) {
      const { unmount } = render(<StatusBadge state={state} />);
      unmount();
    }
  });
});
