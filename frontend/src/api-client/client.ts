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

export interface Conflict {
  id: string;
  workflowId: string;
  aiOutputId: string;
  description: string;
  sourceA: string | null;
  sourceB: string | null;
  status: "OPEN" | "RESOLVED";
  resolution: string | null;
  resolvedById: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export function getConflicts(workflowId: string): Promise<Conflict[]> {
  return apiFetch<Conflict[]>(`/workflows/${workflowId}/conflicts`);
}

export function explainConflict(
  workflowId: string,
  conflictId: string,
  params: { actorId: string; explanation: string },
): Promise<{ conflict: Conflict; workflow: Workflow | null }> {
  return apiFetch(`/workflows/${workflowId}/conflicts/${conflictId}/explain`, {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function restartUpload(workflowId: string, params: { actorId: string }): Promise<Workflow> {
  return apiFetch<Workflow>(`/workflows/${workflowId}/actions/restart-upload`, {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export interface ReportTypeSuggestion {
  id: string;
  workflowId: string;
  version: number;
  aiOutputId: string;
  suggestedType: string;
  rationale: string;
  runnerUp: string | null;
  createdAt: string;
}

export function getReportTypeSuggestion(workflowId: string): Promise<ReportTypeSuggestion> {
  return apiFetch<ReportTypeSuggestion>(`/workflows/${workflowId}/report-type-suggestion`);
}

export function selectReportType(workflowId: string, params: { actorId: string; reportType: string }): Promise<Workflow> {
  return apiFetch<Workflow>(`/workflows/${workflowId}/report-type`, { method: "POST", body: JSON.stringify(params) });
}

export interface DraftSection {
  heading: string;
  content: string;
}

export interface DraftPrecheck {
  id: string;
  overallScore: number;
  checklist: Array<{ item: string; passed: boolean }>;
  blockingIssues: string[];
  recommendation: string;
  createdAt: string;
}

export interface Draft {
  id: string;
  workflowId: string;
  version: number;
  aiOutputId: string;
  reportType: string;
  title: string;
  attendees: string[];
  date: string;
  subject: string;
  sections: DraftSection[];
  coverage: number | null;
  createdAt: string;
  precheck: DraftPrecheck | null;
}

export function getDrafts(workflowId: string): Promise<Draft[]> {
  return apiFetch<Draft[]>(`/workflows/${workflowId}/drafts`);
}

export function getDraft(workflowId: string, version: number): Promise<Draft> {
  return apiFetch<Draft>(`/workflows/${workflowId}/drafts/${version}`);
}

export function reviewDraft(
  workflowId: string,
  version: number,
  params: { actorId: string; decision: "approve" | "request_changes"; feedback?: string },
): Promise<Workflow> {
  return apiFetch<Workflow>(`/workflows/${workflowId}/drafts/${version}/review`, {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export interface FinalReport {
  id: string;
  workflowId: string;
  draftId: string;
  aiOutputId: string;
  title: string;
  format: string;
  storageRef: string;
  createdAt: string;
}

export function getFinalReport(workflowId: string): Promise<FinalReport> {
  return apiFetch<FinalReport>(`/workflows/${workflowId}/final-report`);
}

// Not a fetch call -- a plain URL for an <a href download> link. The backend
// already sets Content-Disposition: attachment, so the browser handles the
// download natively through the same Vite dev proxy every other call uses.
export function finalReportDownloadUrl(workflowId: string): string {
  return `/workflows/${workflowId}/final-report/download`;
}
