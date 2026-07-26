import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ActorType, PolicyType } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ConflictDetectorEnvelope,
  MergerEnvelope,
  ReportTypeAdvisorEnvelope,
  TranscriptQualityEnvelope,
} from "../../src/ai/skillEnvelope";
import { createApp } from "../../src/api/app";
import { handleSkillOutput } from "../../src/approval/gateway";
import { createReportTypeSuggestion } from "../../src/persistence/repositories/reportTypeSuggestionRepository";
import { prisma } from "../../src/persistence/prismaClient";
import * as engine from "../../src/workflow/engine";
import { WorkflowState } from "../../src/workflow/states";

// Requires a real Postgres database -- see docs/phase-1/README.md. Exercises
// the actual HTTP routes for Phase 5's report-type endpoints, mirroring
// conflicts.routes.test.ts's real-server pattern.
const SKILL_NAME = "TranscriptQualityChecker";
const MERGER_SKILL_NAME = "Merger";
const CONFLICT_DETECTOR_SKILL_NAME = "ConflictDetector";
const REPORT_TYPE_ADVISOR_SKILL_NAME = "ReportTypeAdvisor";

function transcriptEnvelope(confidence: number): TranscriptQualityEnvelope {
  return {
    skill: SKILL_NAME,
    schema_version: "1.0.0",
    confidence,
    rationale: "test envelope",
    flags: [],
    result: { sufficient: true, issues: [], metrics: {} },
  };
}

function mergerEnvelope(confidence: number): MergerEnvelope {
  return {
    skill: MERGER_SKILL_NAME,
    schema_version: "1.0.0",
    confidence,
    rationale: "test envelope",
    flags: [],
    result: {
      merged_sections: [{ heading: "Transcript", content: "x", source: "transcript" }],
      unmatched_notes: [],
    },
  };
}

function conflictDetectorEnvelope(confidence: number): ConflictDetectorEnvelope {
  return {
    skill: CONFLICT_DETECTOR_SKILL_NAME,
    schema_version: "1.0.0",
    confidence,
    rationale: "test envelope",
    flags: [],
    result: { conflicts: [] },
  };
}

function reportTypeAdvisorEnvelope(confidence: number): ReportTypeAdvisorEnvelope {
  return {
    skill: REPORT_TYPE_ADVISOR_SKILL_NAME,
    schema_version: "1.0.0",
    confidence,
    rationale: "test envelope",
    flags: [],
    result: { suggested_type: "Standard Audit Summary", rationale: "test rationale", runner_up: "Incident Report" },
  };
}

describe("Phase 5 report-type API", () => {
  let userId: string;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    await prisma.approvalPolicy.upsert({
      where: { skillName: SKILL_NAME },
      update: { policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.75 },
      create: { skillName: SKILL_NAME, policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.75 },
    });
    await prisma.approvalPolicy.upsert({
      where: { skillName: MERGER_SKILL_NAME },
      update: { policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.8 },
      create: { skillName: MERGER_SKILL_NAME, policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.8 },
    });
    await prisma.approvalPolicy.upsert({
      where: { skillName: CONFLICT_DETECTOR_SKILL_NAME },
      update: { policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.7 },
      create: { skillName: CONFLICT_DETECTOR_SKILL_NAME, policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.7 },
    });
    await prisma.approvalPolicy.upsert({
      where: { skillName: REPORT_TYPE_ADVISOR_SKILL_NAME },
      update: { policyType: PolicyType.MANDATORY, confidenceThreshold: null },
      create: { skillName: REPORT_TYPE_ADVISOR_SKILL_NAME, policyType: PolicyType.MANDATORY },
    });

    const user = await prisma.user.create({
      data: {
        name: "Report Type Route Test User",
        email: `report-type-route-test-${randomUUID()}@example.com`,
        role: "reviewer",
      },
    });
    userId = user.id;

    server = createApp().listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await prisma.stateTransition.deleteMany({
      where: { OR: [{ actorId: userId }, { workflow: { createdById: userId } }] },
    });
    await prisma.approvalRequest.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.job.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.aiOutputInput.deleteMany({ where: { aiOutput: { workflow: { createdById: userId } } } });
    await prisma.reportTypeSuggestion.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.conflict.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.merge.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.aiOutput.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.transcript.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.workflow.deleteMany({ where: { createdById: userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  async function workflowAtAwaitingReportTypeSelection(title: string) {
    const workflow = await engine.createWorkflow({ title, createdById: userId });
    await engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "upload_transcript" },
      actor: { actorType: ActorType.USER, actorId: userId },
    });
    await engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "submit_for_validation" },
      actor: { actorType: ActorType.USER, actorId: userId },
    });
    await handleSkillOutput({
      workflowId: workflow.id,
      envelope: transcriptEnvelope(0.95),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });
    await handleSkillOutput({
      workflowId: workflow.id,
      envelope: mergerEnvelope(0.95),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });
    await handleSkillOutput({
      workflowId: workflow.id,
      envelope: conflictDetectorEnvelope(0.9),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });
    const { aiOutputId } = await handleSkillOutput({
      workflowId: workflow.id,
      envelope: reportTypeAdvisorEnvelope(0.85),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });
    // handleSkillOutput() never writes skill-specific rows itself (mirrors
    // Merger/`merges` -- see mergeRunner.ts) -- suggestReportTypeRunner.ts
    // does this in the real flow; this test calls handleSkillOutput()
    // directly (bypassing the job queue), so it's done here instead.
    await createReportTypeSuggestion({
      workflowId: workflow.id,
      aiOutputId,
      suggestedType: "Standard Audit Summary",
      rationale: "test rationale",
      runnerUp: "Incident Report",
    });
    return workflow.id;
  }

  it("GET /workflows/:id/report-type-suggestion returns the latest suggestion", async () => {
    const workflowId = await workflowAtAwaitingReportTypeSelection("Report Type Route Suggestion");

    const response = await fetch(`${baseUrl}/workflows/${workflowId}/report-type-suggestion`);
    expect(response.status).toBe(200);
    const suggestion = (await response.json()) as { suggestedType: string; runnerUp: string };
    expect(suggestion.suggestedType).toBe("Standard Audit Summary");
    expect(suggestion.runnerUp).toBe("Incident Report");
  });

  it("GET /workflows/:id/report-type-suggestion 404s when there is no suggestion yet", async () => {
    const workflow = await engine.createWorkflow({ title: "Report Type Route No Suggestion", createdById: userId });

    const response = await fetch(`${baseUrl}/workflows/${workflow.id}/report-type-suggestion`);
    expect(response.status).toBe(404);
  });

  it("GET /workflows/:id/report-type-suggestion 404s for a nonexistent workflow", async () => {
    const response = await fetch(`${baseUrl}/workflows/${randomUUID()}/report-type-suggestion`);
    expect(response.status).toBe(404);
  });

  it("POST /workflows/:id/report-type advances the workflow to GENERATING_DRAFT and sets reportType", async () => {
    const workflowId = await workflowAtAwaitingReportTypeSelection("Report Type Route Select");

    const response = await fetch(`${baseUrl}/workflows/${workflowId}/report-type`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: userId, reportType: "Incident Report" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { currentState: string; reportType: string };
    expect(body.currentState).toBe(WorkflowState.GENERATING_DRAFT);
    expect(body.reportType).toBe("Incident Report");

    const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId } });
    expect(reloaded.reportType).toBe("Incident Report");
  });

  it("rejects selection when the workflow is not at AWAITING_REPORT_TYPE_SELECTION", async () => {
    const workflow = await engine.createWorkflow({ title: "Report Type Route Not Awaiting", createdById: userId });

    const response = await fetch(`${baseUrl}/workflows/${workflow.id}/report-type`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: userId, reportType: "Anything" }),
    });
    expect(response.status).toBe(409);
  });

  it("rejects an empty reportType", async () => {
    const workflowId = await workflowAtAwaitingReportTypeSelection("Report Type Route Empty Body");

    const response = await fetch(`${baseUrl}/workflows/${workflowId}/report-type`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: userId, reportType: "" }),
    });
    expect(response.status).toBe(400);
  });
});
