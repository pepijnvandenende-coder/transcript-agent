import { describe, expect, it } from "vitest";
import { ApiError } from "./client";
import { translateError, translateJobError } from "./translateError";

describe("api-client/translateError", () => {
  it("maps a known ApiError message fragment to Dutch", () => {
    expect(translateError(new ApiError(404, "Workflow not found"))).toBe("Deze workflow bestaat niet (meer).");
  });

  it("maps an unrecognized ApiError to the generic Dutch fallback", () => {
    expect(translateError(new ApiError(500, "Something exploded"))).toBe(
      "Er is een fout opgetreden. Probeer het opnieuw.",
    );
  });

  it("maps a plain Error (e.g. a network failure) to the generic Dutch fallback", () => {
    expect(translateError(new Error("Failed to fetch"))).toBe("Er is een fout opgetreden. Probeer het opnieuw.");
  });

  it("maps a non-Error value to the generic Dutch fallback", () => {
    expect(translateError("oops")).toBe("Er is een fout opgetreden. Probeer het opnieuw.");
  });

  // Phase 13: jobs.error is a raw string (not a caught exception/ApiError),
  // e.g. from backend/src/jobs/worker.ts's failJob() -- translateJobError()
  // covers that case with the same known-fragment table.
  it("translateJobError maps a known job error fragment to Dutch, never showing the raw English text", () => {
    const dutch = translateJobError("Missing required environment variable: ANTHROPIC_API_KEY");
    expect(dutch).not.toContain("ANTHROPIC_API_KEY");
    expect(dutch).toContain("AI-koppeling");
  });

  it("translateJobError maps an unrecognized job error to the generic Dutch fallback", () => {
    expect(translateJobError("some internal stack trace detail")).toBe("Er is een fout opgetreden. Probeer het opnieuw.");
  });
});
