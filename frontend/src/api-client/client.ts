// A thin, typed fetch wrapper around the backend's HTTP API. Response shapes
// here are hand-typed against what the backend actually returns -- there is
// no shared types package between frontend/backend (see the Phase 10 plan's
// "Risks" section). Requests are relative paths; the Vite dev-server proxy
// (see vite.config.ts) forwards them to the backend, so no base URL/CORS
// handling is needed here.

export type WorkflowState =
  | "CREATED"
  | "TRANSCRIPT_UPLOADED"
  | "VALIDATING_TRANSCRIPT"
  | "TRANSCRIPT_INSUFFICIENT"
  | "PENDING_HUMAN_CONFIRMATION"
  | "MERGING"
  | "DETECTING_CONFLICTS"
  | "CONFLICTS_PENDING_REVIEW"
  | "SUGGESTING_REPORT_TYPE"
  | "AWAITING_REPORT_TYPE_SELECTION"
  | "GENERATING_DRAFT"
  | "DRAFT_QUALITY_PRECHECK"
  | "DRAFT_PENDING_REVIEW"
  | "REVISING_DRAFT"
  | "GENERATING_FINAL"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED";

export interface User {
  id: string;
  name: string;
  email: string;
  role: string;
}

export interface Workflow {
  id: string;
  title: string;
  currentState: WorkflowState;
  reportType: string | null;
  status: "ACTIVE" | "COMPLETED" | "CANCELLED";
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message = (body && typeof body === "object" && "error" in body ? String(body.error) : null) ?? response.statusText;
    throw new ApiError(response.status, message);
  }
  return response.json() as Promise<T>;
}

export function createUser(params: { name: string; email: string }): Promise<User> {
  return apiFetch<User>("/users", { method: "POST", body: JSON.stringify(params) });
}

export function createWorkflow(params: { title: string; createdById: string }): Promise<Workflow> {
  return apiFetch<Workflow>("/workflows", { method: "POST", body: JSON.stringify(params) });
}

export function getWorkflow(workflowId: string): Promise<Workflow> {
  return apiFetch<Workflow>(`/workflows/${workflowId}`);
}

export function uploadTranscript(workflowId: string, params: { uploadedById: string; content: string }) {
  return apiFetch(`/workflows/${workflowId}/transcript`, { method: "POST", body: JSON.stringify(params) });
}

export function uploadNotes(workflowId: string, params: { uploadedById: string; content: string }) {
  return apiFetch(`/workflows/${workflowId}/notes`, { method: "POST", body: JSON.stringify(params) });
}

export function submitForValidation(workflowId: string, params: { actorId: string }): Promise<Workflow> {
  return apiFetch<Workflow>(`/workflows/${workflowId}/actions/validate-transcript`, {
    method: "POST",
    body: JSON.stringify(params),
  });
}
