import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createUser,
  createWorkflow,
  getWorkflow,
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
});
