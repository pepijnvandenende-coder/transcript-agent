import { randomUUID } from "node:crypto";
import { ActorType, PolicyType } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ConflictDetectorEnvelope,
  MergerEnvelope,
  ReportTypeAdvisorEnvelope,
  TranscriptQualityEnvelope,
} from "../../src/ai/skillEnvelope";
import { handleSkillOutput } from "../../src/approval/gateway";
import { selectReportType } from "../../src/approval/reportTypeSelection";
import { NotAwaitingReportTypeSelectionError, UnknownReportTypeError } from "../../src/domain/types";
import { createReportTypeSuggestion } from "../../src/persistence/repositories/reportTypeSuggestionRepository";
import { prisma } from "../../src/persistence/prismaClient";
import * as engine from "../../src/workflow/engine";
import { WorkflowState } from "../../src/workflow/states";

// Requires a real Postgres database -- see docs/phase-1/README.md.
const SKILL_NAME = "TranscriptQualityChecker";
const MERGER_SKILL_NAME = "Merger";
const CONFLICT_DETECTOR_SKILL_NAME = "ConflictDetector";
const REPORT_TYPE_ADVISOR_SKILL_NAME = "ReportTypeAdvisor";

function envelope(overrides: { confidence?: number } = {}): TranscriptQualityEnvelope {
  const { confidence = 0.95 } = overrides;
  return {
    skill: SKILL_NAME,
    schema_version: "1.0.0",
    confidence,
    rationale: "test envelope",
    flags: [],
    result: { sufficient: true, issues: [], metrics: {} },
  };
}

function mergerEnvelope(overrides: { confidence?: number } = {}): MergerEnvelope {
  const { confidence = 0.95 } = overrides;
  return {
    skill: MERGER_SKILL_NAME,
    schema_version: "1.0.0",
    confidence,
    rationale: "test envelope",
    flags: [],
    result: {
      merged_sections: [{ heading: "Transcript", content: "x", source: "transcript" }],
      unmatched_notes: [],
      notes_provided: true,
    },
  };
}

function conflictDetectorEnvelope(overrides: { confidence?: number } = {}): ConflictDetectorEnvelope {
  const { confidence = 0.9 } = overrides;
  return {
    skill: CONFLICT_DETECTOR_SKILL_NAME,
    schema_version: "1.0.0",
    confidence,
    rationale: "test envelope",
    flags: [],
    result: { conflicts: [] },
  };
}

function reportTypeAdvisorEnvelope(overrides: { confidence?: number } = {}): ReportTypeAdvisorEnvelope {
  const { confidence = 0.85 } = overrides;
  return {
    skill: REPORT_TYPE_ADVISOR_SKILL_NAME,
    schema_version: "1.0.0",
    confidence,
    rationale: "test envelope",
    flags: [],
    result: { suggested_type: "Standard Audit Summary", rationale: "test rationale", runner_up: "Incident Report" },
  };
}

describe("approval/reportTypeSelection", () => {
  let userId: string;

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
      where: { skillName: "DraftGenerator" },
      update: { policyType: PolicyType.MANDATORY, confidenceThreshold: null },
      create: { skillName: "DraftGenerator", policyType: PolicyType.MANDATORY },
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
        requiredSections: ["Samenvatting"],
        optionalSections: [],
        bodyContentRule: { type: "topic_sections", minCount: 1 },
      },
    });
    await prisma.reportTypePolicy.upsert({
      where: { key: "qa" },
      update: {},
      create: {
        key: "qa",
        displayName: "Vraag & antwoord gespreksverslag",
        language: "nl",
        promptVersion: "v1",
        promptRef: "qa.md",
        requiredSections: ["Samenvatting"],
        optionalSections: [],
        bodyContentRule: { type: "qa_pairs", minCount: 1 },
      },
    });

    const user = await prisma.user.create({
      data: {
        name: "Report Type Selection Test User",
        email: `report-type-selection-test-${randomUUID()}@example.com`,
        role: "reviewer",
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.stateTransition.deleteMany({
      where: { OR: [{ actorId: userId }, { workflow: { createdById: userId } }] },
    });
    await prisma.approvalRequest.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.job.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.aiOutputInput.deleteMany({ where: { aiOutput: { workflow: { createdById: userId } } } });
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
      envelope: envelope({ confidence: 0.95 }),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });
    await handleSkillOutput({
      workflowId: workflow.id,
      envelope: mergerEnvelope({ confidence: 0.95 }),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });
    await handleSkillOutput({
      workflowId: workflow.id,
      envelope: conflictDetectorEnvelope({ confidence: 0.9 }),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });
    const { aiOutputId } = await handleSkillOutput({
      workflowId: workflow.id,
      envelope: reportTypeAdvisorEnvelope({ confidence: 0.85 }),
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
    return { workflowId: workflow.id, aiOutputId };
  }

  it("sets workflows.reportType (normalized to the policy key), marks the ai_output HUMAN_APPROVED, and advances to GENERATING_DRAFT", async () => {
    const { workflowId, aiOutputId } = await workflowAtAwaitingReportTypeSelection("Report Type Selection Success");

    // Submits the Dutch displayName -- resolved and stored as the English key.
    const updated = await selectReportType({
      workflowId,
      actorId: userId,
      reportType: "Thematisch gespreksverslag",
    });
    expect(updated.currentState).toBe(WorkflowState.GENERATING_DRAFT);
    expect(updated.reportType).toBe("thematic");

    const reloadedWorkflow = await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId } });
    expect(reloadedWorkflow.reportType).toBe("thematic");

    const aiOutput = await prisma.aiOutput.findUniqueOrThrow({ where: { id: aiOutputId } });
    expect(aiOutput.approvalStatus).toBe("HUMAN_APPROVED");
    expect(aiOutput.approvedById).toBe(userId);

    // The suggestion history itself is never mutated by selection.
    const suggestion = await prisma.reportTypeSuggestion.findFirstOrThrow({ where: { workflowId } });
    expect(suggestion.suggestedType).toBe("Standard Audit Summary");
  });

  it("also accepts the English key, case-insensitively", async () => {
    const { workflowId } = await workflowAtAwaitingReportTypeSelection("Report Type Selection By Key");

    const updated = await selectReportType({ workflowId, actorId: userId, reportType: "QA" });
    expect(updated.reportType).toBe("qa");
  });

  it("rejects a report type that doesn't match any catalog entry (Phase 6: no more freeform acceptance)", async () => {
    const { workflowId } = await workflowAtAwaitingReportTypeSelection("Report Type Selection Unknown Type");

    await expect(
      selectReportType({ workflowId, actorId: userId, reportType: "Custom Report Type" }),
    ).rejects.toBeInstanceOf(UnknownReportTypeError);
  });

  it("rejects selection when the workflow is not at AWAITING_REPORT_TYPE_SELECTION", async () => {
    const workflow = await engine.createWorkflow({ title: "Report Type Selection Not Awaiting", createdById: userId });

    await expect(
      selectReportType({ workflowId: workflow.id, actorId: userId, reportType: "thematic" }),
    ).rejects.toBeInstanceOf(NotAwaitingReportTypeSelectionError);
  });
});
