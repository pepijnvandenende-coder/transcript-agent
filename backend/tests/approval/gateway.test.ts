import { randomUUID } from "node:crypto";
import { ActorType, JobStatus, JobType, PolicyType, RetryMode } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ConflictDetectorEnvelope,
  DraftGeneratorEnvelope,
  DraftQualityPrecheckEnvelope,
  DraftReviserEnvelope,
  FinalRendererEnvelope,
  MergerEnvelope,
  ReportTypeAdvisorEnvelope,
  TranscriptQualityEnvelope,
} from "../../src/ai/skillEnvelope";
import {
  confirmApprovalRequest,
  editRetryApprovalRequest,
  handleSkillOutput,
  retryApprovalRequest,
} from "../../src/approval/gateway";
import { InvalidRetryInputError, MaxRetriesExceededError, NotAtCheckpointError } from "../../src/domain/types";
import { prisma } from "../../src/persistence/prismaClient";
import * as engine from "../../src/workflow/engine";
import { WorkflowState } from "../../src/workflow/states";

// Requires a real Postgres database -- see docs/phase-1/README.md.
const SKILL_NAME = "TranscriptQualityChecker";
const MERGER_SKILL_NAME = "Merger";
const CONFLICT_DETECTOR_SKILL_NAME = "ConflictDetector";
const REPORT_TYPE_ADVISOR_SKILL_NAME = "ReportTypeAdvisor";
const DRAFT_GENERATOR_SKILL_NAME = "DraftGenerator";
const DRAFT_QUALITY_PRECHECK_SKILL_NAME = "DraftQualityPrecheck";
const DRAFT_REVISER_SKILL_NAME = "DraftReviser";
const FINAL_RENDERER_SKILL_NAME = "FinalRenderer";

function envelope(
  overrides: { confidence?: number; sufficient?: boolean; issues?: string[] } = {},
): TranscriptQualityEnvelope {
  const { confidence = 0.95, sufficient = true, issues = [] } = overrides;
  return {
    skill: SKILL_NAME,
    schema_version: "1.0.0",
    confidence,
    rationale: "test envelope",
    flags: [],
    result: { sufficient, issues, metrics: {} },
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
    },
  };
}

function conflictDetectorEnvelope(
  overrides: { confidence?: number; conflicts?: Array<{ description: string; source_b?: string }> } = {},
): ConflictDetectorEnvelope {
  const { confidence = 0.9, conflicts = [] } = overrides;
  return {
    skill: CONFLICT_DETECTOR_SKILL_NAME,
    schema_version: "1.0.0",
    confidence,
    rationale: "test envelope",
    flags: [],
    result: { conflicts },
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

function draftGeneratorEnvelope(overrides: { confidence?: number } = {}): DraftGeneratorEnvelope {
  const { confidence = 0.8 } = overrides;
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

function draftQualityPrecheckEnvelope(overrides: { confidence?: number } = {}): DraftQualityPrecheckEnvelope {
  const { confidence = 1 } = overrides;
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

function draftReviserEnvelope(overrides: { confidence?: number } = {}): DraftReviserEnvelope {
  const { confidence = 0.8 } = overrides;
  return {
    skill: DRAFT_REVISER_SKILL_NAME,
    schema_version: "1.0.0",
    confidence,
    rationale: "test envelope",
    flags: [],
    result: {
      sections: [
        { heading: "Samenvatting", content: "x" },
        { heading: "Notulen", content: "y\n\nAanvulling naar aanleiding van reviewer-feedback: please expand" },
      ],
      changes_applied: ["Aanvulling naar aanleiding van reviewer-feedback: please expand"],
      unresolved_feedback: [],
    },
  };
}

function finalRendererEnvelope(overrides: { confidence?: number } = {}): FinalRendererEnvelope {
  const { confidence = 1 } = overrides;
  return {
    skill: FINAL_RENDERER_SKILL_NAME,
    schema_version: "1.0.0",
    confidence,
    rationale: "test envelope",
    flags: [],
    result: { rendered: true },
  };
}

describe("approval/gateway", () => {
  let userId: string;

  beforeAll(async () => {
    await prisma.approvalPolicy.upsert({
      where: { skillName: SKILL_NAME },
      update: { policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.75, maxRetries: 5 },
      create: { skillName: SKILL_NAME, policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.75 },
    });
    await prisma.approvalPolicy.upsert({
      where: { skillName: MERGER_SKILL_NAME },
      update: { policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.8, maxRetries: 5 },
      create: { skillName: MERGER_SKILL_NAME, policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.8 },
    });
    await prisma.approvalPolicy.upsert({
      where: { skillName: CONFLICT_DETECTOR_SKILL_NAME },
      update: { policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.7, maxRetries: 5 },
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
      where: { skillName: DRAFT_REVISER_SKILL_NAME },
      update: { policyType: PolicyType.MANDATORY, confidenceThreshold: null },
      create: { skillName: DRAFT_REVISER_SKILL_NAME, policyType: PolicyType.MANDATORY },
    });
    await prisma.approvalPolicy.upsert({
      where: { skillName: FINAL_RENDERER_SKILL_NAME },
      update: { policyType: PolicyType.AUTO, confidenceThreshold: null },
      create: { skillName: FINAL_RENDERER_SKILL_NAME, policyType: PolicyType.AUTO },
    });

    const user = await prisma.user.create({
      data: { name: "Gateway Test User", email: `gateway-test-${randomUUID()}@example.com`, role: "reviewer" },
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
    await prisma.merge.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.conflict.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.reportTypeSuggestion.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.draft.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.aiOutput.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.transcript.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.note.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.workflow.deleteMany({ where: { createdById: userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  async function workflowAtValidating(title: string) {
    const workflow = await engine.createWorkflow({ title, createdById: userId });
    await engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "upload_transcript" },
      actor: { actorType: ActorType.USER, actorId: userId },
    });
    return engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "submit_for_validation" },
      actor: { actorType: ActorType.USER, actorId: userId },
    });
  }

  it("auto-approves a high-confidence, sufficient result and advances to MERGING", async () => {
    const workflow = await workflowAtValidating("Gateway Auto Approve");

    await handleSkillOutput({
      workflowId: workflow.id,
      envelope: envelope({ confidence: 0.95 }),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });

    const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
    expect(reloaded.currentState).toBe(WorkflowState.MERGING);

    const aiOutput = await prisma.aiOutput.findFirstOrThrow({ where: { workflowId: workflow.id } });
    expect(aiOutput.approvalStatus).toBe("AUTO_APPROVED");
    expect(aiOutput.policyApplied).toBe("AUTO_IF_ABOVE");
    expect(aiOutput.validationStatus).toBe("VALID");
    expect(aiOutput.attemptNumber).toBe(1);
  });

  it("auto-approving into MERGING auto-enqueues a MERGE job (no separate start-merge action)", async () => {
    const workflow = await workflowAtValidating("Gateway Auto Enqueue Merge");

    await handleSkillOutput({
      workflowId: workflow.id,
      envelope: envelope({ confidence: 0.95 }),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });

    const job = await prisma.job.findFirstOrThrow({ where: { workflowId: workflow.id, jobType: JobType.MERGE } });
    expect(job.status).toBe(JobStatus.QUEUED);
    expect(job.retryOfAiOutputId).toBeNull();
  });

  it("routes sufficient=false straight to TRANSCRIPT_INSUFFICIENT regardless of confidence", async () => {
    const workflow = await workflowAtValidating("Gateway Insufficient");

    await handleSkillOutput({
      workflowId: workflow.id,
      envelope: envelope({ confidence: 0.99, sufficient: false, issues: ["transcript_empty"] }),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });

    const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
    expect(reloaded.currentState).toBe(WorkflowState.TRANSCRIPT_INSUFFICIENT);
  });

  it("opens PENDING_HUMAN_CONFIRMATION on low confidence, and confirm (no AI re-run) advances to MERGING", async () => {
    const workflow = await workflowAtValidating("Gateway Low Confidence");

    await handleSkillOutput({
      workflowId: workflow.id,
      envelope: envelope({ confidence: 0.5 }),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });

    let reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
    expect(reloaded.currentState).toBe(WorkflowState.PENDING_HUMAN_CONFIRMATION);

    const openRequest = await prisma.approvalRequest.findFirstOrThrow({ where: { workflowId: workflow.id } });
    expect(openRequest.status).toBe("PENDING");
    expect(openRequest.attemptCount).toBe(1);
    const aiOutputCountBefore = await prisma.aiOutput.count({ where: { workflowId: workflow.id } });

    reloaded = await confirmApprovalRequest({ workflowId: workflow.id, actorId: userId });
    expect(reloaded.currentState).toBe(WorkflowState.MERGING);

    // Confirm must not have re-run the skill -- no new ai_outputs row.
    const aiOutputCountAfter = await prisma.aiOutput.count({ where: { workflowId: workflow.id } });
    expect(aiOutputCountAfter).toBe(aiOutputCountBefore);

    const resolvedRequest = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: openRequest.id } });
    expect(resolvedRequest.status).toBe("RESOLVED");
    expect(resolvedRequest.resolution).toBe("confirmed");

    const aiOutput = await prisma.aiOutput.findUniqueOrThrow({ where: { id: openRequest.aiOutputId } });
    expect(aiOutput.approvalStatus).toBe("HUMAN_APPROVED");
    expect(aiOutput.approvedById).toBe(userId);
  });

  it("opens PENDING_HUMAN_CONFIRMATION on schema-invalid output", async () => {
    const workflow = await workflowAtValidating("Gateway Schema Invalid");

    const invalidEnvelope = { ...envelope(), confidence: 5 }; // out of [0,1] range -> fails schema

    await handleSkillOutput({
      workflowId: workflow.id,
      envelope: invalidEnvelope,
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });

    const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
    expect(reloaded.currentState).toBe(WorkflowState.PENDING_HUMAN_CONFIRMATION);

    const aiOutput = await prisma.aiOutput.findFirstOrThrow({ where: { workflowId: workflow.id } });
    expect(aiOutput.validationStatus).toBe("INVALID");
    expect(aiOutput.validationErrors).not.toBeNull();
  });

  it("refuses to confirm a workflow that is not at PENDING_HUMAN_CONFIRMATION", async () => {
    const workflow = await workflowAtValidating("Gateway Not At Checkpoint");

    await handleSkillOutput({
      workflowId: workflow.id,
      envelope: envelope({ confidence: 0.95 }),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });
    // workflow is now at MERGING (auto-approved), not a checkpoint.

    await expect(confirmApprovalRequest({ workflowId: workflow.id, actorId: userId })).rejects.toBeInstanceOf(
      NotAtCheckpointError,
    );
    await expect(retryApprovalRequest({ workflowId: workflow.id, actorId: userId })).rejects.toBeInstanceOf(
      NotAtCheckpointError,
    );
  });

  describe("Merger routing (MERGING -> DETECTING_CONFLICTS)", () => {
    async function workflowAtMerging(title: string) {
      const workflow = await workflowAtValidating(title);
      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: envelope({ confidence: 0.95 }),
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });
      return prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
    }

    it("auto-approves a high-confidence Merger result and advances to DETECTING_CONFLICTS", async () => {
      const workflow = await workflowAtMerging("Gateway Merger Auto Approve");

      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: mergerEnvelope({ confidence: 0.95 }),
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });

      const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
      expect(reloaded.currentState).toBe(WorkflowState.DETECTING_CONFLICTS);
    });

    it("opens PENDING_HUMAN_CONFIRMATION on low Merger confidence", async () => {
      const workflow = await workflowAtMerging("Gateway Merger Low Confidence");

      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: mergerEnvelope({ confidence: 0.3 }),
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });

      const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
      expect(reloaded.currentState).toBe(WorkflowState.PENDING_HUMAN_CONFIRMATION);
    });

    it("opens PENDING_HUMAN_CONFIRMATION on schema-invalid Merger output", async () => {
      const workflow = await workflowAtMerging("Gateway Merger Schema Invalid");

      const invalid = { ...mergerEnvelope(), confidence: -1 };

      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: invalid,
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });

      const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
      expect(reloaded.currentState).toBe(WorkflowState.PENDING_HUMAN_CONFIRMATION);
    });
  });

  describe("ConflictDetector routing (DETECTING_CONFLICTS -> ...)", () => {
    async function workflowAtDetectingConflicts(title: string) {
      const workflow = await workflowAtValidating(title);
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
      return prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
    }

    it("routes conflicts-found straight to CONFLICTS_PENDING_REVIEW without auto-approving or opening a generic approval_requests episode", async () => {
      const workflow = await workflowAtDetectingConflicts("Gateway ConflictDetector Conflicts Found");

      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: conflictDetectorEnvelope({
          confidence: 0.9,
          conflicts: [{ description: "a conflict", source_b: "a stray note" }],
        }),
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });

      const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
      expect(reloaded.currentState).toBe(WorkflowState.CONFLICTS_PENDING_REVIEW);

      const aiOutput = await prisma.aiOutput.findFirstOrThrow({
        where: { workflowId: workflow.id, skillName: CONFLICT_DETECTOR_SKILL_NAME },
      });
      // Not auto-approved -- a human hasn't reviewed anything yet.
      expect(aiOutput.approvalStatus).toBe("PENDING");

      // No generic checkpoint episode -- CONFLICTS_PENDING_REVIEW has its own
      // explain/restart actions, not confirm/retry/edit-retry.
      const openRequest = await prisma.approvalRequest.findFirst({ where: { aiOutputId: aiOutput.id } });
      expect(openRequest).toBeNull();
    });

    it("auto-approves a no-conflicts, high-confidence ConflictDetector result and advances to SUGGESTING_REPORT_TYPE", async () => {
      const workflow = await workflowAtDetectingConflicts("Gateway ConflictDetector No Conflicts Auto Approve");

      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: conflictDetectorEnvelope({ confidence: 0.9 }),
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });

      const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
      expect(reloaded.currentState).toBe(WorkflowState.SUGGESTING_REPORT_TYPE);
    });

    it("opens the generic PENDING_HUMAN_CONFIRMATION checkpoint on no-conflicts, low-confidence, and confirm advances to SUGGESTING_REPORT_TYPE", async () => {
      const workflow = await workflowAtDetectingConflicts("Gateway ConflictDetector Low Confidence");

      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: conflictDetectorEnvelope({ confidence: 0.3 }),
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });

      let reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
      expect(reloaded.currentState).toBe(WorkflowState.PENDING_HUMAN_CONFIRMATION);

      // Reuses Phase 3's confirmApprovalRequest with zero code changes.
      reloaded = await confirmApprovalRequest({ workflowId: workflow.id, actorId: userId });
      expect(reloaded.currentState).toBe(WorkflowState.SUGGESTING_REPORT_TYPE);
    });

    it("opens PENDING_HUMAN_CONFIRMATION on schema-invalid ConflictDetector output", async () => {
      const workflow = await workflowAtDetectingConflicts("Gateway ConflictDetector Schema Invalid");

      const invalid = { ...conflictDetectorEnvelope(), confidence: -1 };

      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: invalid,
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });

      const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
      expect(reloaded.currentState).toBe(WorkflowState.PENDING_HUMAN_CONFIRMATION);
    });

    it("edit-retry against a ConflictDetector checkpoint rejects -- it declares no editable inputs", async () => {
      const workflow = await workflowAtDetectingConflicts("Gateway ConflictDetector Edit Retry Rejected");

      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: conflictDetectorEnvelope({ confidence: 0.3 }),
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });

      await expect(
        editRetryApprovalRequest({ workflowId: workflow.id, actorId: userId, transcriptContent: "anything" }),
      ).rejects.toBeInstanceOf(InvalidRetryInputError);
    });
  });

  describe("ReportTypeAdvisor routing (SUGGESTING_REPORT_TYPE -> AWAITING_REPORT_TYPE_SELECTION)", () => {
    async function workflowAtSuggestingReportType(title: string) {
      const workflow = await workflowAtValidating(title);
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
      return prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
    }

    it("always transitions via report_type_suggested regardless of confidence -- no low/auto split, no auto-approval", async () => {
      const workflow = await workflowAtSuggestingReportType("Gateway ReportTypeAdvisor Low Confidence Still Proceeds");

      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: reportTypeAdvisorEnvelope({ confidence: 0.01 }),
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });

      const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
      expect(reloaded.currentState).toBe(WorkflowState.AWAITING_REPORT_TYPE_SELECTION);

      const aiOutput = await prisma.aiOutput.findFirstOrThrow({
        where: { workflowId: workflow.id, skillName: REPORT_TYPE_ADVISOR_SKILL_NAME },
      });
      // Not auto-approved -- the human hasn't made the required explicit
      // choice yet (see approval/reportTypeSelection.ts).
      expect(aiOutput.approvalStatus).toBe("PENDING");

      // No generic checkpoint episode -- ReportTypeAdvisor never opens one.
      const openRequest = await prisma.approvalRequest.findFirst({ where: { aiOutputId: aiOutput.id } });
      expect(openRequest).toBeNull();
    });

    it("schema-invalid output ALSO proceeds via report_type_suggested (Key Design Finding) -- no stuck workflow, no approval_requests", async () => {
      const workflow = await workflowAtSuggestingReportType("Gateway ReportTypeAdvisor Schema Invalid");

      const invalid = { ...reportTypeAdvisorEnvelope(), confidence: -1 };

      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: invalid,
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });

      const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
      expect(reloaded.currentState).toBe(WorkflowState.AWAITING_REPORT_TYPE_SELECTION);

      const aiOutput = await prisma.aiOutput.findFirstOrThrow({
        where: { workflowId: workflow.id, skillName: REPORT_TYPE_ADVISOR_SKILL_NAME },
      });
      expect(aiOutput.validationStatus).toBe("INVALID");
      expect(aiOutput.validationErrors).not.toBeNull();
      expect(aiOutput.approvalStatus).toBe("PENDING");

      const openRequest = await prisma.approvalRequest.findFirst({ where: { aiOutputId: aiOutput.id } });
      expect(openRequest).toBeNull();
    });
  });

  describe("DraftGenerator routing (GENERATING_DRAFT -> DRAFT_QUALITY_PRECHECK)", () => {
    async function workflowAtGeneratingDraft(title: string) {
      const workflow = await workflowAtValidating(title);
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
      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: reportTypeAdvisorEnvelope({ confidence: 0.85 }),
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });
      // select_report_type is a plain user_action (like submit_for_validation
      // above) -- reached directly via engine.transition() here since these
      // tests exercise handleSkillOutput() directly, bypassing
      // approval/reportTypeSelection.ts's catalog validation entirely.
      await engine.transition({
        workflowId: workflow.id,
        trigger: { kind: "user_action", action: "select_report_type" },
        actor: { actorType: ActorType.USER, actorId: userId },
      });
      return prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
    }

    it("always transitions via draft_generated regardless of confidence -- no low/auto split, no auto-approval", async () => {
      const workflow = await workflowAtGeneratingDraft("Gateway DraftGenerator Low Confidence Still Proceeds");

      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: draftGeneratorEnvelope({ confidence: 0.01 }),
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });

      const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
      expect(reloaded.currentState).toBe(WorkflowState.DRAFT_QUALITY_PRECHECK);

      const aiOutput = await prisma.aiOutput.findFirstOrThrow({
        where: { workflowId: workflow.id, skillName: DRAFT_GENERATOR_SKILL_NAME },
      });
      // Not auto-approved -- the (later-phase) human checkpoint at
      // DRAFT_PENDING_REVIEW hasn't happened yet.
      expect(aiOutput.approvalStatus).toBe("PENDING");

      // No generic checkpoint episode -- DraftGenerator never opens one.
      const openRequest = await prisma.approvalRequest.findFirst({ where: { aiOutputId: aiOutput.id } });
      expect(openRequest).toBeNull();
    });

    it("schema-invalid output ALSO proceeds via draft_generated -- no stuck workflow, no approval_requests", async () => {
      const workflow = await workflowAtGeneratingDraft("Gateway DraftGenerator Schema Invalid");

      const invalid = { ...draftGeneratorEnvelope(), confidence: -1 };

      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: invalid,
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });

      const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
      expect(reloaded.currentState).toBe(WorkflowState.DRAFT_QUALITY_PRECHECK);

      const aiOutput = await prisma.aiOutput.findFirstOrThrow({
        where: { workflowId: workflow.id, skillName: DRAFT_GENERATOR_SKILL_NAME },
      });
      expect(aiOutput.validationStatus).toBe("INVALID");
      expect(aiOutput.validationErrors).not.toBeNull();
      expect(aiOutput.approvalStatus).toBe("PENDING");

      const openRequest = await prisma.approvalRequest.findFirst({ where: { aiOutputId: aiOutput.id } });
      expect(openRequest).toBeNull();
    });

    it("rejects a structurally-invalid draft (missing a required section) via additionalValidation, same as a schema failure", async () => {
      const workflow = await workflowAtGeneratingDraft("Gateway DraftGenerator Structural Invalid");

      const missingNotulen = {
        ...draftGeneratorEnvelope(),
        result: { ...draftGeneratorEnvelope().result, sections: [{ heading: "Samenvatting", content: "x" }] },
      };

      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: missingNotulen,
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
        additionalValidation: () => ({ valid: false, errors: ["Missing required section(s): Notulen"] }),
      });

      const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
      // Still proceeds -- same bypassEvent shape as a schema failure.
      expect(reloaded.currentState).toBe(WorkflowState.DRAFT_QUALITY_PRECHECK);

      const aiOutput = await prisma.aiOutput.findFirstOrThrow({
        where: { workflowId: workflow.id, skillName: DRAFT_GENERATOR_SKILL_NAME },
      });
      expect(aiOutput.validationStatus).toBe("INVALID");
      expect(aiOutput.validationErrors).toEqual(["Missing required section(s): Notulen"]);
    });
  });

  describe("DraftQualityPrecheck routing (DRAFT_QUALITY_PRECHECK -> DRAFT_PENDING_REVIEW)", () => {
    async function workflowAtDraftQualityPrecheck(title: string) {
      const workflow = await workflowAtValidating(title);
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
      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: reportTypeAdvisorEnvelope({ confidence: 0.85 }),
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });
      await engine.transition({
        workflowId: workflow.id,
        trigger: { kind: "user_action", action: "select_report_type" },
        actor: { actorType: ActorType.USER, actorId: userId },
      });
      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: draftGeneratorEnvelope({ confidence: 0.8 }),
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });
      return prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
    }

    it("schema-valid output auto-approves and transitions via precheck_completed, regardless of confidence (ADVISORY_ONLY never gates)", async () => {
      const workflow = await workflowAtDraftQualityPrecheck("Gateway DraftQualityPrecheck Auto Approves");

      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: draftQualityPrecheckEnvelope({ confidence: 0.01 }),
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });

      const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
      expect(reloaded.currentState).toBe(WorkflowState.DRAFT_PENDING_REVIEW);

      const aiOutput = await prisma.aiOutput.findFirstOrThrow({
        where: { workflowId: workflow.id, skillName: DRAFT_QUALITY_PRECHECK_SKILL_NAME },
      });
      // Unlike ReportTypeAdvisor/DraftGenerator (MANDATORY, stays PENDING),
      // DraftQualityPrecheck (ADVISORY_ONLY) genuinely auto-approves -- nobody
      // ever explicitly "approves the precheck itself".
      expect(aiOutput.approvalStatus).toBe("AUTO_APPROVED");
      expect(aiOutput.policyApplied).toBe("ADVISORY_ONLY");

      const openRequest = await prisma.approvalRequest.findFirst({ where: { aiOutputId: aiOutput.id } });
      expect(openRequest).toBeNull();
    });

    it("schema-invalid output ALSO proceeds via precheck_completed -- no stuck workflow, no approval_requests, stays PENDING", async () => {
      const workflow = await workflowAtDraftQualityPrecheck("Gateway DraftQualityPrecheck Schema Invalid");

      const invalid = { ...draftQualityPrecheckEnvelope(), confidence: -1 };

      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: invalid,
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });

      const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
      expect(reloaded.currentState).toBe(WorkflowState.DRAFT_PENDING_REVIEW);

      const aiOutput = await prisma.aiOutput.findFirstOrThrow({
        where: { workflowId: workflow.id, skillName: DRAFT_QUALITY_PRECHECK_SKILL_NAME },
      });
      expect(aiOutput.validationStatus).toBe("INVALID");
      expect(aiOutput.validationErrors).not.toBeNull();
      // Not auto-approved on the invalid path -- there was nothing valid to approve.
      expect(aiOutput.approvalStatus).toBe("PENDING");

      const openRequest = await prisma.approvalRequest.findFirst({ where: { aiOutputId: aiOutput.id } });
      expect(openRequest).toBeNull();
    });
  });

  describe("DraftReviser routing (REVISING_DRAFT -> DRAFT_QUALITY_PRECHECK)", () => {
    async function workflowAtRevisingDraft(title: string) {
      const workflow = await workflowAtValidating(title);
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
      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: reportTypeAdvisorEnvelope({ confidence: 0.85 }),
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });
      await engine.transition({
        workflowId: workflow.id,
        trigger: { kind: "user_action", action: "select_report_type" },
        actor: { actorType: ActorType.USER, actorId: userId },
      });
      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: draftGeneratorEnvelope({ confidence: 0.8 }),
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });
      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: draftQualityPrecheckEnvelope(),
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });
      // request_draft_changes is a plain user_action on DRAFT_PENDING_REVIEW --
      // bypassed directly here (like select_report_type above) since these
      // tests exercise handleSkillOutput() directly, not
      // approval/draftReview.ts's requestDraftChanges().
      await engine.transition({
        workflowId: workflow.id,
        trigger: { kind: "user_action", action: "request_draft_changes" },
        actor: { actorType: ActorType.USER, actorId: userId },
      });
      return prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
    }

    it("always transitions via draft_revised regardless of confidence -- no low/auto split, no auto-approval", async () => {
      const workflow = await workflowAtRevisingDraft("Gateway DraftReviser Low Confidence Still Proceeds");

      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: draftReviserEnvelope({ confidence: 0.01 }),
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });

      const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
      expect(reloaded.currentState).toBe(WorkflowState.DRAFT_QUALITY_PRECHECK);

      const aiOutput = await prisma.aiOutput.findFirstOrThrow({
        where: { workflowId: workflow.id, skillName: DRAFT_REVISER_SKILL_NAME },
      });
      // Not auto-approved -- the (later-phase) human checkpoint at
      // DRAFT_PENDING_REVIEW hasn't happened yet for this revised version.
      expect(aiOutput.approvalStatus).toBe("PENDING");

      const openRequest = await prisma.approvalRequest.findFirst({ where: { aiOutputId: aiOutput.id } });
      expect(openRequest).toBeNull();
    });

    it("schema-invalid output ALSO proceeds via draft_revised -- no stuck workflow, no approval_requests", async () => {
      const workflow = await workflowAtRevisingDraft("Gateway DraftReviser Schema Invalid");

      const invalid = { ...draftReviserEnvelope(), confidence: -1 };

      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: invalid,
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });

      const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
      expect(reloaded.currentState).toBe(WorkflowState.DRAFT_QUALITY_PRECHECK);

      const aiOutput = await prisma.aiOutput.findFirstOrThrow({
        where: { workflowId: workflow.id, skillName: DRAFT_REVISER_SKILL_NAME },
      });
      expect(aiOutput.validationStatus).toBe("INVALID");
      expect(aiOutput.validationErrors).not.toBeNull();
      expect(aiOutput.approvalStatus).toBe("PENDING");

      const openRequest = await prisma.approvalRequest.findFirst({ where: { aiOutputId: aiOutput.id } });
      expect(openRequest).toBeNull();
    });
  });

  describe("FinalRenderer routing (GENERATING_FINAL -> COMPLETED)", () => {
    async function workflowAtGeneratingFinal(title: string) {
      const workflow = await workflowAtValidating(title);
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
      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: reportTypeAdvisorEnvelope({ confidence: 0.85 }),
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });
      await engine.transition({
        workflowId: workflow.id,
        trigger: { kind: "user_action", action: "select_report_type" },
        actor: { actorType: ActorType.USER, actorId: userId },
      });
      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: draftGeneratorEnvelope({ confidence: 0.8 }),
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });
      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: draftQualityPrecheckEnvelope(),
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });
      // approve_draft is a plain user_action on DRAFT_PENDING_REVIEW --
      // bypassed directly here (like select_report_type above) since these
      // tests exercise handleSkillOutput() directly, not
      // approval/draftReview.ts's approveDraft().
      await engine.transition({
        workflowId: workflow.id,
        trigger: { kind: "user_action", action: "approve_draft" },
        actor: { actorType: ActorType.USER, actorId: userId },
      });
      return prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
    }

    it("schema-valid output auto-approves and transitions via final_rendered, regardless of confidence (AUTO never gates)", async () => {
      const workflow = await workflowAtGeneratingFinal("Gateway FinalRenderer Auto Approves");

      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: finalRendererEnvelope({ confidence: 0.01 }),
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });

      const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
      expect(reloaded.currentState).toBe(WorkflowState.COMPLETED);
      expect(reloaded.status).toBe("COMPLETED");

      const aiOutput = await prisma.aiOutput.findFirstOrThrow({
        where: { workflowId: workflow.id, skillName: FINAL_RENDERER_SKILL_NAME },
      });
      // Genuinely auto-approves, same as DraftQualityPrecheck's ADVISORY_ONLY --
      // nobody ever explicitly "approves the render itself".
      expect(aiOutput.approvalStatus).toBe("AUTO_APPROVED");
      expect(aiOutput.policyApplied).toBe("AUTO");

      const openRequest = await prisma.approvalRequest.findFirst({ where: { aiOutputId: aiOutput.id } });
      expect(openRequest).toBeNull();
    });

    it("schema-invalid output ALSO proceeds via final_rendered -- no stuck workflow, no approval_requests, stays PENDING", async () => {
      const workflow = await workflowAtGeneratingFinal("Gateway FinalRenderer Schema Invalid");

      const invalid = { ...finalRendererEnvelope(), result: { rendered: false } } as unknown as FinalRendererEnvelope;

      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: invalid,
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });

      const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
      expect(reloaded.currentState).toBe(WorkflowState.COMPLETED);

      const aiOutput = await prisma.aiOutput.findFirstOrThrow({
        where: { workflowId: workflow.id, skillName: FINAL_RENDERER_SKILL_NAME },
      });
      expect(aiOutput.validationStatus).toBe("INVALID");
      expect(aiOutput.validationErrors).not.toBeNull();
      expect(aiOutput.approvalStatus).toBe("PENDING");

      const openRequest = await prisma.approvalRequest.findFirst({ where: { aiOutputId: aiOutput.id } });
      expect(openRequest).toBeNull();
    });
  });

  describe("retry / edit-retry at PENDING_HUMAN_CONFIRMATION", () => {
    async function workflowAtCheckpoint(title: string) {
      const workflow = await workflowAtValidating(title);
      await handleSkillOutput({
        workflowId: workflow.id,
        envelope: envelope({ confidence: 0.5 }),
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
      });
      const openRequest = await prisma.approvalRequest.findFirstOrThrow({ where: { workflowId: workflow.id } });
      return { workflowId: workflow.id, openRequest };
    }

    it("retry routes back through the originating PROCESSING state and enqueues a SAME_INPUT job", async () => {
      const { workflowId, openRequest } = await workflowAtCheckpoint("Gateway Retry");

      const updated = await retryApprovalRequest({ workflowId, actorId: userId, reviewerComment: "try again" });
      expect(updated.currentState).toBe(WorkflowState.VALIDATING_TRANSCRIPT);

      const resolvedRequest = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: openRequest.id } });
      expect(resolvedRequest.status).toBe("RESOLVED");
      expect(resolvedRequest.resolution).toBe("retried");

      const oldOutput = await prisma.aiOutput.findUniqueOrThrow({ where: { id: openRequest.aiOutputId } });
      expect(oldOutput.reviewerComment).toBe("try again");

      const job = await prisma.job.findFirstOrThrow({
        where: { workflowId, jobType: JobType.VALIDATE_TRANSCRIPT, retryOfAiOutputId: openRequest.aiOutputId },
      });
      expect(job.retryMode).toBe(RetryMode.SAME_INPUT);

      // Simulate the runner completing the retried job: attempt_number
      // increments from the output being retried, and lineage is recorded.
      const { aiOutputId } = await handleSkillOutput({
        workflowId,
        envelope: envelope({ confidence: 0.95 }),
        promptVersion: "stub-1",
        schemaVersion: "1.0.0",
        retryOfAiOutputId: openRequest.aiOutputId,
        retryMode: RetryMode.SAME_INPUT,
      });
      const newOutput = await prisma.aiOutput.findUniqueOrThrow({ where: { id: aiOutputId } });
      expect(newOutput.attemptNumber).toBe(2);
      expect(newOutput.retryOfAiOutputId).toBe(openRequest.aiOutputId);
      expect(newOutput.retryMode).toBe(RetryMode.SAME_INPUT);
    });

    it("edit-retry records a new transcript version and enqueues an EDITED_INPUT job", async () => {
      const { workflowId, openRequest } = await workflowAtCheckpoint("Gateway Edit Retry");

      const updated = await editRetryApprovalRequest({
        workflowId,
        actorId: userId,
        transcriptContent: "an edited transcript with new content",
      });
      expect(updated.currentState).toBe(WorkflowState.VALIDATING_TRANSCRIPT);

      const transcripts = await prisma.transcript.findMany({ where: { workflowId }, orderBy: { version: "asc" } });
      expect(transcripts).toHaveLength(1);
      expect(transcripts[0].version).toBe(1);

      const resolvedRequest = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: openRequest.id } });
      expect(resolvedRequest.resolution).toBe("edited_input");

      const job = await prisma.job.findFirstOrThrow({
        where: { workflowId, jobType: JobType.VALIDATE_TRANSCRIPT, retryOfAiOutputId: openRequest.aiOutputId },
      });
      expect(job.retryMode).toBe(RetryMode.EDITED_INPUT);
    });

    it("edit-retry rejects an input type the checkpoint's skill doesn't consume", async () => {
      const { workflowId } = await workflowAtCheckpoint("Gateway Edit Retry Invalid Input");

      await expect(
        editRetryApprovalRequest({ workflowId, actorId: userId, notesContent: "notes TranscriptQualityChecker never reads" }),
      ).rejects.toBeInstanceOf(InvalidRetryInputError);
    });

    it("blocks retry once the episode's attemptCount reaches the skill's maxRetries", async () => {
      await prisma.approvalPolicy.update({ where: { skillName: SKILL_NAME }, data: { maxRetries: 1 } });
      try {
        const { workflowId } = await workflowAtCheckpoint("Gateway Max Retries");

        await expect(retryApprovalRequest({ workflowId, actorId: userId })).rejects.toBeInstanceOf(
          MaxRetriesExceededError,
        );
      } finally {
        await prisma.approvalPolicy.update({ where: { skillName: SKILL_NAME }, data: { maxRetries: 5 } });
      }
    });
  });
});
