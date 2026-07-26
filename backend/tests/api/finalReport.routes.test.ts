import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ActorType, PolicyType } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ConflictDetectorEnvelope,
  DraftGeneratorEnvelope,
  DraftQualityPrecheckEnvelope,
  FinalRendererEnvelope,
  MergerEnvelope,
  ReportTypeAdvisorEnvelope,
  TranscriptQualityEnvelope,
} from "../../src/ai/skillEnvelope";
import * as finalRenderer from "../../src/ai/skills/finalRenderer";
import { createApp } from "../../src/api/app";
import { handleSkillOutput } from "../../src/approval/gateway";
import { createDraftVersion } from "../../src/persistence/repositories/draftRepository";
import { createFinalReport } from "../../src/persistence/repositories/finalReportRepository";
import { prisma } from "../../src/persistence/prismaClient";
import { localFilesystemStorage } from "../../src/storage/localFilesystemStorage";
import * as engine from "../../src/workflow/engine";
import { WorkflowState } from "../../src/workflow/states";

// Requires a real Postgres database -- see docs/phase-1/README.md. Exercises
// the actual HTTP routes for Phase 9's final-report endpoints, mirroring
// reportType.routes.test.ts's/drafts.routes.test.ts's real-server pattern.
const SKILL_NAME = "TranscriptQualityChecker";
const MERGER_SKILL_NAME = "Merger";
const CONFLICT_DETECTOR_SKILL_NAME = "ConflictDetector";
const REPORT_TYPE_ADVISOR_SKILL_NAME = "ReportTypeAdvisor";
const DRAFT_GENERATOR_SKILL_NAME = "DraftGenerator";
const DRAFT_QUALITY_PRECHECK_SKILL_NAME = "DraftQualityPrecheck";
const FINAL_RENDERER_SKILL_NAME = "FinalRenderer";

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
      attendees: ["Jan (voorzitter)"],
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

function finalRendererEnvelope(confidence: number): FinalRendererEnvelope {
  return {
    skill: FINAL_RENDERER_SKILL_NAME,
    schema_version: "1.0.0",
    confidence,
    rationale: "test envelope",
    flags: [],
    result: { rendered: true },
  };
}

describe("Phase 9 final-report API", () => {
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
    await prisma.approvalPolicy.upsert({
      where: { skillName: FINAL_RENDERER_SKILL_NAME },
      update: { policyType: PolicyType.AUTO, confidenceThreshold: null },
      create: { skillName: FINAL_RENDERER_SKILL_NAME, policyType: PolicyType.AUTO },
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
      data: { name: "Final Report Route Test User", email: `final-report-route-test-${randomUUID()}@example.com`, role: "reviewer" },
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
    await prisma.finalReport.deleteMany({ where: { workflow: { createdById: userId } } });
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

  async function workflowAtCompleted(title: string) {
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
      attendees: ["Jan (voorzitter)"],
      date: "2026-01-01",
      subject: "Test",
      sections: [
        { heading: "Samenvatting", content: "x" },
        { heading: "Notulen", content: "y" },
      ],
      coverage: 0.7,
    });
    await handleSkillOutput({
      workflowId: workflow.id,
      envelope: draftQualityPrecheckEnvelope(1),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });
    await engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "approve_draft" },
      actor: { actorType: ActorType.USER, actorId: userId },
    });
    const { aiOutputId: finalAiOutputId } = await handleSkillOutput({
      workflowId: workflow.id,
      envelope: finalRendererEnvelope(1),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });
    // handleSkillOutput() never writes skill-specific rows itself -- this
    // test calls it directly (bypassing the job queue/finalRendererRunner.ts),
    // so the rendered content + final_reports row are created here instead.
    const content = finalRenderer.renderContent({
      title: draft.title,
      attendees: draft.attendees as unknown as string[],
      date: draft.date,
      subject: draft.subject,
      sections: draft.sections as unknown as Array<{ heading: string; content: string }>,
    });
    const storageRef = `${workflow.id}/final-reports/report.md`;
    await localFilesystemStorage.put(storageRef, content);
    await createFinalReport({
      workflowId: workflow.id,
      draftId: draft.id,
      aiOutputId: finalAiOutputId,
      title: draft.title,
      format: "markdown",
      storageRef,
    });
    return workflow.id;
  }

  it("GET /workflows/:id/final-report returns metadata once completed", async () => {
    const workflowId = await workflowAtCompleted("Final Report Route Metadata");

    const response = await fetch(`${baseUrl}/workflows/${workflowId}/final-report`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { title: string; format: string };
    expect(body.title).toBe("Gespreksverslag Test");
    expect(body.format).toBe("markdown");

    const workflow = await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId } });
    expect(workflow.currentState).toBe(WorkflowState.COMPLETED);
  });

  it("GET /workflows/:id/final-report/download returns the rendered content", async () => {
    const workflowId = await workflowAtCompleted("Final Report Route Download");

    const response = await fetch(`${baseUrl}/workflows/${workflowId}/final-report/download`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/markdown/);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    const text = await response.text();
    expect(text).toContain("Titel: Gespreksverslag Test");
    expect(text).toContain("## Notulen");
  });

  it("GET /workflows/:id/final-report 404s when the workflow has no final report yet", async () => {
    const workflow = await engine.createWorkflow({ title: "Final Report Route Not Yet", createdById: userId });

    const response = await fetch(`${baseUrl}/workflows/${workflow.id}/final-report`);
    expect(response.status).toBe(404);
  });

  it("GET /workflows/:id/final-report/download 404s when the workflow has no final report yet", async () => {
    const workflow = await engine.createWorkflow({ title: "Final Report Route Download Not Yet", createdById: userId });

    const response = await fetch(`${baseUrl}/workflows/${workflow.id}/final-report/download`);
    expect(response.status).toBe(404);
  });

  it("GET /workflows/:id/final-report 404s for a nonexistent workflow", async () => {
    const response = await fetch(`${baseUrl}/workflows/${randomUUID()}/final-report`);
    expect(response.status).toBe(404);
  });
});
