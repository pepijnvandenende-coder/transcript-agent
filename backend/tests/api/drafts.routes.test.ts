import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ActorType, PolicyType } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ConflictDetectorEnvelope,
  DraftGeneratorEnvelope,
  DraftQualityPrecheckEnvelope,
  MergerEnvelope,
  ReportTypeAdvisorEnvelope,
  TranscriptQualityEnvelope,
} from "../../src/ai/skillEnvelope";
import { createApp } from "../../src/api/app";
import { handleSkillOutput } from "../../src/approval/gateway";
import { createDraftPrecheck } from "../../src/persistence/repositories/draftPrecheckRepository";
import { createDraftVersion } from "../../src/persistence/repositories/draftRepository";
import { prisma } from "../../src/persistence/prismaClient";
import * as engine from "../../src/workflow/engine";
import { WorkflowState } from "../../src/workflow/states";

// Requires a real Postgres database -- see docs/phase-1/README.md. Exercises
// the actual HTTP routes for Phase 7's draft & review endpoints, mirroring
// reportType.routes.test.ts's real-server pattern.
const SKILL_NAME = "TranscriptQualityChecker";
const MERGER_SKILL_NAME = "Merger";
const CONFLICT_DETECTOR_SKILL_NAME = "ConflictDetector";
const REPORT_TYPE_ADVISOR_SKILL_NAME = "ReportTypeAdvisor";
const DRAFT_GENERATOR_SKILL_NAME = "DraftGenerator";
const DRAFT_QUALITY_PRECHECK_SKILL_NAME = "DraftQualityPrecheck";

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

function draftGeneratorEnvelope(confidence: number): DraftGeneratorEnvelope {
  return {
    skill: DRAFT_GENERATOR_SKILL_NAME,
    schema_version: "1.0.0",
    confidence,
    rationale: "test envelope",
    flags: [],
    result: {
      report_type: "thematic",
      title: "Gespreksverslag Test",
      attendees: [],
      date: "2026-01-01",
      subject: "Test",
      sections: [
        { heading: "Samenvatting", content: "x" },
        { heading: "Notulen", content: "y" },
      ],
      coverage: 0.7,
    },
  };
}

function draftQualityPrecheckEnvelope(confidence: number): DraftQualityPrecheckEnvelope {
  return {
    skill: DRAFT_QUALITY_PRECHECK_SKILL_NAME,
    schema_version: "1.0.0",
    confidence,
    rationale: "test envelope",
    flags: [],
    result: {
      overall_score: 1,
      checklist: [
        { item: "Samenvatting", passed: true },
        { item: "Notulen", passed: true },
      ],
      blocking_issues: [],
      recommendation: "Looks complete.",
    },
  };
}

describe("Phase 7 draft & review API", () => {
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
    await prisma.approvalPolicy.upsert({
      where: { skillName: DRAFT_GENERATOR_SKILL_NAME },
      update: { policyType: PolicyType.MANDATORY, confidenceThreshold: null },
      create: { skillName: DRAFT_GENERATOR_SKILL_NAME, policyType: PolicyType.MANDATORY },
    });
    await prisma.approvalPolicy.upsert({
      where: { skillName: DRAFT_QUALITY_PRECHECK_SKILL_NAME },
      update: { policyType: PolicyType.ADVISORY_ONLY, confidenceThreshold: null },
      create: { skillName: DRAFT_QUALITY_PRECHECK_SKILL_NAME, policyType: PolicyType.ADVISORY_ONLY },
    });
    await prisma.reportTypePolicy.upsert({
      where: { key: "thematic" },
      update: {},
      create: {
        key: "thematic",
        displayName: "Thematisch gespreksverslag",
        language: "nl",
        promptVersion: "v1",
        promptRef: "thematic.md",
        requiredSections: ["Samenvatting", "Notulen"],
        optionalSections: [],
      },
    });

    const user = await prisma.user.create({
      data: { name: "Drafts Route Test User", email: `drafts-route-test-${randomUUID()}@example.com`, role: "reviewer" },
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
    await prisma.reviewFeedback.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.draftPrecheck.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.reportTypeSuggestion.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.draft.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.conflict.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.merge.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.aiOutput.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.transcript.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.workflow.deleteMany({ where: { createdById: userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  async function workflowAtDraftPendingReview(title: string) {
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
    await handleSkillOutput({
      workflowId: workflow.id,
      envelope: reportTypeAdvisorEnvelope(0.85),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });
    await engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "select_report_type" },
      actor: { actorType: ActorType.USER, actorId: userId },
    });
    const { aiOutputId: draftAiOutputId } = await handleSkillOutput({
      workflowId: workflow.id,
      envelope: draftGeneratorEnvelope(0.8),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });
    const draft = await createDraftVersion({
      workflowId: workflow.id,
      aiOutputId: draftAiOutputId,
      reportType: "thematic",
      title: "Gespreksverslag Test",
      attendees: [],
      date: "2026-01-01",
      subject: "Test",
      sections: [
        { heading: "Samenvatting", content: "x" },
        { heading: "Notulen", content: "y" },
      ],
      coverage: 0.7,
    });
    const { aiOutputId: precheckAiOutputId } = await handleSkillOutput({
      workflowId: workflow.id,
      envelope: draftQualityPrecheckEnvelope(1),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });
    // handleSkillOutput() never writes skill-specific rows itself (mirrors
    // Merger/ReportTypeAdvisor/DraftGenerator -- see
    // draftQualityPrecheckRunner.ts). This test calls handleSkillOutput()
    // directly (bypassing the job queue), so it's done here instead.
    await createDraftPrecheck({
      workflowId: workflow.id,
      draftId: draft.id,
      aiOutputId: precheckAiOutputId,
      overallScore: 1,
      checklist: [
        { item: "Samenvatting", passed: true },
        { item: "Notulen", passed: true },
      ],
      blockingIssues: [],
      recommendation: "Looks complete.",
    });
    return { workflowId: workflow.id, draft };
  }

  it("GET /workflows/:id/drafts lists every version", async () => {
    const { workflowId, draft } = await workflowAtDraftPendingReview("Drafts Route List");

    const response = await fetch(`${baseUrl}/workflows/${workflowId}/drafts`);
    expect(response.status).toBe(200);
    const drafts = (await response.json()) as Array<{ version: number }>;
    expect(drafts).toHaveLength(1);
    expect(drafts[0].version).toBe(draft.version);
  });

  it("GET /workflows/:id/drafts/:version returns the specific version with its precheck annotation", async () => {
    const { workflowId, draft } = await workflowAtDraftPendingReview("Drafts Route Get Version");

    const response = await fetch(`${baseUrl}/workflows/${workflowId}/drafts/${draft.version}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { version: number; precheck: { overallScore: number } | null };
    expect(body.version).toBe(draft.version);
    expect(body.precheck).not.toBeNull();
    expect(body.precheck?.overallScore).toBe(1);
  });

  it("GET /workflows/:id/drafts/:version 404s for an unknown version", async () => {
    const { workflowId } = await workflowAtDraftPendingReview("Drafts Route Unknown Version");

    const response = await fetch(`${baseUrl}/workflows/${workflowId}/drafts/999`);
    expect(response.status).toBe(404);
  });

  it("POST .../review with decision 'approve' advances to GENERATING_FINAL", async () => {
    const { workflowId, draft } = await workflowAtDraftPendingReview("Drafts Route Approve");

    const response = await fetch(`${baseUrl}/workflows/${workflowId}/drafts/${draft.version}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: userId, decision: "approve" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { currentState: string };
    expect(body.currentState).toBe(WorkflowState.GENERATING_FINAL);
  });

  it("POST .../review with decision 'request_changes' + feedback advances to REVISING_DRAFT", async () => {
    const { workflowId, draft } = await workflowAtDraftPendingReview("Drafts Route Request Changes");

    const response = await fetch(`${baseUrl}/workflows/${workflowId}/drafts/${draft.version}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: userId, decision: "request_changes", feedback: "Expand the Notulen." }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { currentState: string };
    expect(body.currentState).toBe(WorkflowState.REVISING_DRAFT);

    const feedback = await prisma.reviewFeedback.findFirstOrThrow({ where: { draftId: draft.id } });
    expect(feedback.feedback).toBe("Expand the Notulen.");
  });

  it("POST .../review with decision 'request_changes' and no feedback 400s", async () => {
    const { workflowId, draft } = await workflowAtDraftPendingReview("Drafts Route Missing Feedback");

    const response = await fetch(`${baseUrl}/workflows/${workflowId}/drafts/${draft.version}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: userId, decision: "request_changes" }),
    });
    expect(response.status).toBe(400);
  });

  it("POST .../review 409s when the workflow is not at DRAFT_PENDING_REVIEW", async () => {
    const workflow = await engine.createWorkflow({ title: "Drafts Route Not At Checkpoint", createdById: userId });

    const response = await fetch(`${baseUrl}/workflows/${workflow.id}/drafts/1/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: userId, decision: "approve" }),
    });
    expect(response.status).toBe(409);
  });

  it("POST .../review 409s when the version isn't the current latest draft", async () => {
    const { workflowId } = await workflowAtDraftPendingReview("Drafts Route Stale Version");

    const response = await fetch(`${baseUrl}/workflows/${workflowId}/drafts/999/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: userId, decision: "approve" }),
    });
    expect(response.status).toBe(409);
  });
});
