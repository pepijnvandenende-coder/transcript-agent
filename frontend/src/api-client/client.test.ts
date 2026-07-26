import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createUser,
  createWorkflow,
  explainConflict,
  finalReportDownloadUrl,
  getConflicts,
  getDraft,
  getDrafts,
  getFinalReport,
  getReportTypeSuggestion,
  getWorkflow,
  restartUpload,
  reviewDraft,
  selectReportType,
  submitForValidation,
  uploadNotes,
  uploadTranscript,
} from "./client";

function mockFetchOnce(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: "mocked",
    json: () => Promise.resolve(body),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("api-client/client", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("createUser posts to /users with the given name/email and returns the parsed user", async () => {
    const fetchMock = mockFetchOnce(200, { id: "u1", name: "Jan", email: "jan@example.com", role: "member" });

    const user = await createUser({ name: "Jan", email: "jan@example.com" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/users",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "Jan", email: "jan@example.com" }) }),
    );
    expect(user).toEqual({ id: "u1", name: "Jan", email: "jan@example.com", role: "member" });
  });

  it("createWorkflow posts to /workflows with title and createdById", async () => {
    const fetchMock = mockFetchOnce(201, { id: "w1", currentState: "CREATED" });

    await createWorkflow({ title: "Test", createdById: "u1" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/workflows",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ title: "Test", createdById: "u1" }) }),
    );
  });

  it("getWorkflow issues a GET to /workflows/:id", async () => {
    const fetchMock = mockFetchOnce(200, { id: "w1", currentState: "CREATED" });

    const workflow = await getWorkflow("w1");

    expect(fetchMock).toHaveBeenCalledWith("/workflows/w1", expect.anything());
    expect(workflow.id).toBe("w1");
  });

  it("uploadTranscript posts the transcript content to /workflows/:id/transcript", async () => {
    const fetchMock = mockFetchOnce(201, { id: "t1" });

    await uploadTranscript("w1", { uploadedById: "u1", content: "hello" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/workflows/w1/transcript",
      expect.objectContaining({ body: JSON.stringify({ uploadedById: "u1", content: "hello" }) }),
    );
  });

  it("uploadNotes posts the notes content to /workflows/:id/notes", async () => {
    const fetchMock = mockFetchOnce(201, { id: "n1" });

    await uploadNotes("w1", { uploadedById: "u1", content: "note text" });

    expect(fetchMock).toHaveBeenCalledWith("/workflows/w1/notes", expect.anything());
  });

  it("submitForValidation posts to /workflows/:id/actions/validate-transcript", async () => {
    const fetchMock = mockFetchOnce(202, { id: "w1", currentState: "VALIDATING_TRANSCRIPT" });

    const workflow = await submitForValidation("w1", { actorId: "u1" });

    expect(fetchMock).toHaveBeenCalledWith("/workflows/w1/actions/validate-transcript", expect.anything());
    expect(workflow.currentState).toBe("VALIDATING_TRANSCRIPT");
  });

  it("throws an ApiError with the backend's error message on a non-2xx response", async () => {
    mockFetchOnce(404, { error: "Workflow not found" });

    await expect(getWorkflow("missing")).rejects.toBeInstanceOf(ApiError);
    await expect(getWorkflow("missing")).rejects.toThrow("Workflow not found");
  });

  it("getConflicts issues a GET to /workflows/:id/conflicts", async () => {
    const fetchMock = mockFetchOnce(200, [{ id: "c1", status: "OPEN" }]);

    const conflicts = await getConflicts("w1");

    expect(fetchMock).toHaveBeenCalledWith("/workflows/w1/conflicts", expect.anything());
    expect(conflicts).toHaveLength(1);
  });

  it("explainConflict posts the explanation to /workflows/:id/conflicts/:conflictId/explain", async () => {
    const fetchMock = mockFetchOnce(200, { conflict: { id: "c1", status: "RESOLVED" }, workflow: null });

    await explainConflict("w1", "c1", { actorId: "u1", explanation: "clarified" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/workflows/w1/conflicts/c1/explain",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ actorId: "u1", explanation: "clarified" }) }),
    );
  });

  it("restartUpload posts to /workflows/:id/actions/restart-upload", async () => {
    const fetchMock = mockFetchOnce(200, { id: "w1", currentState: "TRANSCRIPT_UPLOADED" });

    await restartUpload("w1", { actorId: "u1" });

    expect(fetchMock).toHaveBeenCalledWith("/workflows/w1/actions/restart-upload", expect.anything());
  });

  it("getReportTypeSuggestion issues a GET to /workflows/:id/report-type-suggestion", async () => {
    const fetchMock = mockFetchOnce(200, { suggestedType: "Thematisch gespreksverslag", runnerUp: null });

    await getReportTypeSuggestion("w1");

    expect(fetchMock).toHaveBeenCalledWith("/workflows/w1/report-type-suggestion", expect.anything());
  });

  it("selectReportType posts the chosen type to /workflows/:id/report-type", async () => {
    const fetchMock = mockFetchOnce(200, { id: "w1", currentState: "GENERATING_DRAFT" });

    await selectReportType("w1", { actorId: "u1", reportType: "thematic" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/workflows/w1/report-type",
      expect.objectContaining({ body: JSON.stringify({ actorId: "u1", reportType: "thematic" }) }),
    );
  });

  it("getDrafts issues a GET to /workflows/:id/drafts", async () => {
    const fetchMock = mockFetchOnce(200, [{ id: "d1", version: 1 }]);

    await getDrafts("w1");

    expect(fetchMock).toHaveBeenCalledWith("/workflows/w1/drafts", expect.anything());
  });

  it("getDraft issues a GET to /workflows/:id/drafts/:version", async () => {
    const fetchMock = mockFetchOnce(200, { id: "d1", version: 2 });

    await getDraft("w1", 2);

    expect(fetchMock).toHaveBeenCalledWith("/workflows/w1/drafts/2", expect.anything());
  });

  it("reviewDraft posts the decision to /workflows/:id/drafts/:version/review", async () => {
    const fetchMock = mockFetchOnce(200, { id: "w1", currentState: "REVISING_DRAFT" });

    await reviewDraft("w1", 1, { actorId: "u1", decision: "request_changes", feedback: "expand this" });

    expect(fetchMock).toHaveBeenCalledWith(
      "/workflows/w1/drafts/1/review",
      expect.objectContaining({
        body: JSON.stringify({ actorId: "u1", decision: "request_changes", feedback: "expand this" }),
      }),
    );
  });

  it("getFinalReport issues a GET to /workflows/:id/final-report", async () => {
    const fetchMock = mockFetchOnce(200, { id: "f1", format: "markdown" });

    await getFinalReport("w1");

    expect(fetchMock).toHaveBeenCalledWith("/workflows/w1/final-report", expect.anything());
  });

  it("finalReportDownloadUrl builds the download path without calling fetch", () => {
    expect(finalReportDownloadUrl("w1")).toBe("/workflows/w1/final-report/download");
  });
});
