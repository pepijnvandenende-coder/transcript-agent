import { randomUUID } from "node:crypto";
import { ActorType, JobStatus, JobType, PolicyType, PostProcessingResultStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Same mocking convention as tests/jobs/worker.test.ts: getAnthropicClient()
// is shared by every LLM-calling skill, so this branches on the requested
// structured-output schema's own properties. OpenQuestionsAnalyzer's branch
// additionally inspects the outgoing user message for a marker string
// (embedded in the draft's own title/subject by the failure test below) so a
// single test file can exercise both the success and the failure/invalid-
// output path without a second mock setup.
const FAILURE_MARKER = "TRIGGER_POSTPROCESSING_FAILURE";

vi.mock("../../src/ai/anthropicClient", () => ({
  getAnthropicClient: () => ({
    messages: {
      create: vi.fn().mockImplementation((params: {
        output_config?: { format?: { schema?: { properties?: Record<string, unknown> } } };
        messages: Array<{ content: string }>;
      }) => {
        const properties = params.output_config?.format?.schema?.properties ?? {};
        const isOpenQuestions = "open_questions" in properties;
        const isCriteriaCoverage = "items" in properties;
        const isDraftQualityPrecheck = "factually_grounded" in properties;
        const isReportTypeClassification = "suggested_type" in properties;

        if (isOpenQuestions) {
          if (params.messages[0].content.includes(FAILURE_MARKER)) {
            return Promise.reject(new Error("Simulated OpenQuestionsAnalyzer failure"));
          }
          return Promise.resolve({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  open_questions: [
                    { question: "Is de planning definitief?", explanation: "Dit staat nog open in het gesprek." },
                  ],
                }),
              },
            ],
          });
        }
        if (isCriteriaCoverage) {
          return Promise.resolve({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  items: [{ criterion: "Toegangsbeveiliging", status: "covered", explanation: "Uitgebreid besproken." }],
                }),
              },
            ],
          });
        }
        if (isDraftQualityPrecheck) {
          return Promise.resolve({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  attendees: { correct: true, reason: "" },
                  date: { correct: true, reason: "" },
                  subject: { correct: true, reason: "" },
                  factually_grounded: { grounded: true, reason: "" },
                }),
              },
            ],
          });
        }
        if (isReportTypeClassification) {
          return Promise.resolve({
            content: [{ type: "text", text: JSON.stringify({ suggested_type: "thematic", rationale: "x", runner_up: "qa" }) }],
          });
        }
        return Promise.resolve({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                title: "Gespreksverslag Test",
                attendees: [],
                conversation_date: null,
                sections: [{ heading: "Samenvatting", content: "x" }],
                actions_present: false,
              }),
            },
          ],
        });
      }),
    },
  }),
}));

import { handleSkillOutput } from "../../src/approval/gateway";
import { processNextJob } from "../../src/jobs/worker";
import { prisma } from "../../src/persistence/prismaClient";
import { createContextItemVersion } from "../../src/persistence/repositories/contextItemRepository";
import { createDraftVersion } from "../../src/persistence/repositories/draftRepository";
import { findPostProcessingResultsForWorkflow } from "../../src/persistence/repositories/postProcessingResultRepository";
import * as engine from "../../src/workflow/engine";
import { WorkflowState } from "../../src/workflow/states";
import type {
  ConflictDetectorEnvelope,
  DraftGeneratorEnvelope,
  DraftQualityPrecheckEnvelope,
  FinalRendererEnvelope,
  MergerEnvelope,
  ReportTypeAdvisorEnvelope,
  TranscriptQualityEnvelope,
} from "../../src/ai/skillEnvelope";

// Requires a real Postgres database -- see docs/phase-1/README.md. Covers
// the Phase 18 generic post-processing phase end-to-end through the real
// job queue/postProcessingRunner.ts (not handleSkillOutput() called
// directly, unlike gateway.test.ts) -- this is what actually exercises the
// per-skill success/skip/failure branching and result persistence.
const SKILL_NAME = "TranscriptQualityChecker";
const MERGER_SKILL_NAME = "Merger";
const CONFLICT_DETECTOR_SKILL_NAME = "ConflictDetector";
const REPORT_TYPE_ADVISOR_SKILL_NAME = "ReportTypeAdvisor";
const DRAFT_GENERATOR_SKILL_NAME = "DraftGenerator";
const DRAFT_QUALITY_PRECHECK_SKILL_NAME = "DraftQualityPrecheck";
const FINAL_RENDERER_SKILL_NAME = "FinalRenderer";

function transcriptEnvelope(): TranscriptQualityEnvelope {
  return {
    skill: SKILL_NAME,
    schema_version: "1.0.0",
    confidence: 0.95,
    rationale: "test envelope",
    flags: [],
    result: { sufficient: true, issues: [], metrics: {} },
  };
}
function mergerEnvelope(): MergerEnvelope {
  return {
    skill: MERGER_SKILL_NAME,
    schema_version: "1.0.0",
    confidence: 0.95,
    rationale: "test envelope",
    flags: [],
    result: { merged_sections: [{ heading: "Transcript", content: "x", source: "transcript" }], unmatched_notes: [], notes_provided: true },
  };
}
function conflictDetectorEnvelope(): ConflictDetectorEnvelope {
  return {
    skill: CONFLICT_DETECTOR_SKILL_NAME,
    schema_version: "1.0.0",
    confidence: 0.9,
    rationale: "test envelope",
    flags: [],
    result: { conflicts: [] },
  };
}
function reportTypeAdvisorEnvelope(): ReportTypeAdvisorEnvelope {
  return {
    skill: REPORT_TYPE_ADVISOR_SKILL_NAME,
    schema_version: "1.0.0",
    confidence: 0.85,
    rationale: "test envelope",
    flags: [],
    result: { suggested_type: "thematic", rationale: "x", runner_up: "qa" },
  };
}
function draftGeneratorEnvelope(subject: string): DraftGeneratorEnvelope {
  return {
    skill: DRAFT_GENERATOR_SKILL_NAME,
    schema_version: "1.0.0",
    confidence: 0.8,
    rationale: "test envelope",
    flags: [],
    result: {
      report_type: "thematic",
      title: "Gespreksverslag Test",
      attendees: [],
      date: "2026-01-01",
      subject,
      sections: [{ heading: "Samenvatting", content: "x" }],
      coverage: 0.7,
      actions_present: false,
    },
  };
}
function draftQualityPrecheckEnvelope(): DraftQualityPrecheckEnvelope {
  return {
    skill: DRAFT_QUALITY_PRECHECK_SKILL_NAME,
    schema_version: "1.0.0",
    confidence: 1,
    rationale: "test envelope",
    flags: [],
    result: { overall_score: 1, checklist: [], blocking_issues: [], recommendation: "x" },
  };
}
function finalRendererEnvelope(): FinalRendererEnvelope {
  return {
    skill: FINAL_RENDERER_SKILL_NAME,
    schema_version: "1.0.0",
    confidence: 1,
    rationale: "test envelope",
    flags: [],
    result: { rendered: true },
  };
}

async function processUntilSettled(jobId: string, maxAttempts = 50): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    if (job.status !== JobStatus.QUEUED) return;
    const didWork = await processNextJob();
    if (!didWork) await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("jobs/runners/postProcessingRunner.ts (real job queue)", () => {
  let userId: string;

  beforeAll(async () => {
    for (const [skillName, policyType] of [
      [SKILL_NAME, PolicyType.AUTO_IF_ABOVE],
      [MERGER_SKILL_NAME, PolicyType.AUTO_IF_ABOVE],
      [CONFLICT_DETECTOR_SKILL_NAME, PolicyType.AUTO_IF_ABOVE],
      [REPORT_TYPE_ADVISOR_SKILL_NAME, PolicyType.MANDATORY],
      [DRAFT_GENERATOR_SKILL_NAME, PolicyType.MANDATORY],
      [DRAFT_QUALITY_PRECHECK_SKILL_NAME, PolicyType.ADVISORY_ONLY],
      [FINAL_RENDERER_SKILL_NAME, PolicyType.AUTO],
      ["PostProcessing", PolicyType.AUTO],
    ] as const) {
      await prisma.approvalPolicy.upsert({
        where: { skillName },
        update: { policyType, confidenceThreshold: policyType === PolicyType.AUTO_IF_ABOVE ? 0.5 : null },
        create: { skillName, policyType, confidenceThreshold: policyType === PolicyType.AUTO_IF_ABOVE ? 0.5 : null },
      });
    }
    await prisma.reportTypePolicy.upsert({
      where: { key: "thematic" },
      update: {},
      create: {
        key: "thematic",
        displayName: "Thematisch gespreksverslag",
        language: "nl",
        promptVersion: "v1",
        promptRef: "thematic.md",
        requiredSections: [],
        optionalSections: [],
        bodyContentRule: { type: "topic_sections", minCount: 0 },
      },
    });
    // Self-seeded catalog rows -- see context.routes.test.ts's comment for
    // why this never relies on prisma/seed.ts having been run.
    await prisma.contextTypePolicy.upsert({
      where: { key: "normenkader" },
      update: { isActive: true },
      create: {
        key: "normenkader",
        displayName: "Normenkader",
        instructionLabel: "Normenkader",
        sortOrder: 1,
      },
    });
    await prisma.postProcessingSkillPolicy.upsert({
      where: { key: "open_questions" },
      update: { isActive: true, requiresContextType: null, promptRef: "openQuestions.md" },
      create: { key: "open_questions", displayName: "Openstaande vragen", promptRef: "openQuestions.md", sortOrder: 1 },
    });
    await prisma.postProcessingSkillPolicy.upsert({
      where: { key: "norm_coverage" },
      update: { isActive: true, requiresContextType: "normenkader", promptRef: "criteriaCoverage.md" },
      create: {
        key: "norm_coverage",
        displayName: "Normenkader / criteria coverage",
        promptRef: "criteriaCoverage.md",
        requiresContextType: "normenkader",
        sortOrder: 2,
      },
    });

    const user = await prisma.user.create({
      data: { name: "Post-processing Runner Test User", email: `pp-runner-test-${randomUUID()}@example.com`, role: "reviewer" },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.postProcessingResult.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.contextItem.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.stateTransition.deleteMany({ where: { OR: [{ actorId: userId }, { workflow: { createdById: userId } }] } });
    await prisma.job.updateMany({ where: { workflow: { createdById: userId } }, data: { resultAiOutputId: null } });
    await prisma.aiOutputInput.deleteMany({ where: { aiOutput: { workflow: { createdById: userId } } } });
    await prisma.draftPrecheck.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.reportTypeSuggestion.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.merge.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.draft.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.aiOutput.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.job.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.transcript.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.workflow.deleteMany({ where: { createdById: userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  // Drives a fresh workflow up to POST_PROCESSING (auto-enqueuing
  // RUN_POST_PROCESSING via the same enqueueForStateEntry mechanism every
  // other PROCESSING state uses), bypassing the earlier job queue steps via
  // handleSkillOutput() directly -- same scope decision as
  // tests/api/finalReport.routes.test.ts's workflowAtCompleted().
  async function driveToPostProcessing(title: string, subject: string): Promise<string> {
    const workflow = await engine.createWorkflow({ title, createdById: userId });
    await engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "continue_to_transcript" },
      actor: { actorType: ActorType.USER, actorId: userId },
    });
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
    await handleSkillOutput({ workflowId: workflow.id, envelope: transcriptEnvelope(), promptVersion: "stub-1", schemaVersion: "1.0.0" });
    await handleSkillOutput({ workflowId: workflow.id, envelope: mergerEnvelope(), promptVersion: "stub-1", schemaVersion: "1.0.0" });
    await handleSkillOutput({ workflowId: workflow.id, envelope: conflictDetectorEnvelope(), promptVersion: "stub-1", schemaVersion: "1.0.0" });
    await handleSkillOutput({ workflowId: workflow.id, envelope: reportTypeAdvisorEnvelope(), promptVersion: "stub-1", schemaVersion: "1.0.0" });
    await engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "select_report_type" },
      actor: { actorType: ActorType.USER, actorId: userId },
    });
    const draftEnvelope = draftGeneratorEnvelope(subject);
    const { aiOutputId: draftAiOutputId } = await handleSkillOutput({
      workflowId: workflow.id,
      envelope: draftEnvelope,
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });
    // postProcessingRunner.ts reads the latest `drafts` row directly (same as
    // finalRendererRunner.ts) -- handleSkillOutput() never writes it itself.
    await createDraftVersion({
      workflowId: workflow.id,
      aiOutputId: draftAiOutputId,
      reportType: draftEnvelope.result.report_type,
      title: draftEnvelope.result.title,
      attendees: draftEnvelope.result.attendees,
      date: draftEnvelope.result.date,
      subject: draftEnvelope.result.subject,
      sections: draftEnvelope.result.sections,
      coverage: draftEnvelope.result.coverage,
      actionsPresent: draftEnvelope.result.actions_present,
    });
    await handleSkillOutput({ workflowId: workflow.id, envelope: draftQualityPrecheckEnvelope(), promptVersion: "stub-1", schemaVersion: "1.0.0" });
    await engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "approve_draft" },
      actor: { actorType: ActorType.USER, actorId: userId },
    });
    await handleSkillOutput({ workflowId: workflow.id, envelope: finalRendererEnvelope(), promptVersion: "stub-1", schemaVersion: "1.0.0" });

    const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
    expect(reloaded.currentState).toBe(WorkflowState.POST_PROCESSING);
    return workflow.id;
  }

  it("runs OpenQuestionsAnalyzer (no context required) and skips CriteriaCoverage (no normenkader uploaded), then reaches COMPLETED", async () => {
    const workflowId = await driveToPostProcessing("Post-processing: no normenkader", "Onderwerp zonder normenkader");

    const job = await prisma.job.findFirstOrThrow({ where: { workflowId, jobType: JobType.RUN_POST_PROCESSING } });
    await processUntilSettled(job.id);

    const completedJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(completedJob.status).toBe(JobStatus.SUCCEEDED);

    const workflow = await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId } });
    expect(workflow.currentState).toBe(WorkflowState.COMPLETED);

    const results = await findPostProcessingResultsForWorkflow(workflowId);
    const openQuestions = results.find((r) => r.skillKey === "open_questions");
    const normCoverage = results.find((r) => r.skillKey === "norm_coverage");

    expect(openQuestions?.status).toBe(PostProcessingResultStatus.COMPLETED);
    expect(openQuestions?.aiOutputId).not.toBeNull();
    expect((openQuestions?.resultJson as { open_questions: unknown[] }).open_questions).toHaveLength(1);

    expect(normCoverage?.status).toBe(PostProcessingResultStatus.SKIPPED);
    expect(normCoverage?.aiOutputId).toBeNull();
    expect(normCoverage?.errorMessage).toContain("normenkader");
  });

  it("runs CriteriaCoverage once a normenkader context item is uploaded for the workflow", async () => {
    const workflow = await engine.createWorkflow({ title: "Post-processing: with normenkader", createdById: userId });
    await engine.transition({ workflowId: workflow.id, trigger: { kind: "user_action", action: "continue_to_transcript" }, actor: { actorType: ActorType.USER, actorId: userId } });
    await engine.transition({ workflowId: workflow.id, trigger: { kind: "user_action", action: "upload_transcript" }, actor: { actorType: ActorType.USER, actorId: userId } });
    await createContextItemVersion({ workflowId: workflow.id, contextType: "normenkader", uploadedById: userId, content: "Norm 1: toegangsbeveiliging." });
    await engine.transition({ workflowId: workflow.id, trigger: { kind: "user_action", action: "submit_for_validation" }, actor: { actorType: ActorType.USER, actorId: userId } });
    await handleSkillOutput({ workflowId: workflow.id, envelope: transcriptEnvelope(), promptVersion: "stub-1", schemaVersion: "1.0.0" });
    await handleSkillOutput({ workflowId: workflow.id, envelope: mergerEnvelope(), promptVersion: "stub-1", schemaVersion: "1.0.0" });
    await handleSkillOutput({ workflowId: workflow.id, envelope: conflictDetectorEnvelope(), promptVersion: "stub-1", schemaVersion: "1.0.0" });
    await handleSkillOutput({ workflowId: workflow.id, envelope: reportTypeAdvisorEnvelope(), promptVersion: "stub-1", schemaVersion: "1.0.0" });
    await engine.transition({ workflowId: workflow.id, trigger: { kind: "user_action", action: "select_report_type" }, actor: { actorType: ActorType.USER, actorId: userId } });
    const draftEnvelope = draftGeneratorEnvelope("Onderwerp met normenkader");
    const { aiOutputId: draftAiOutputId } = await handleSkillOutput({ workflowId: workflow.id, envelope: draftEnvelope, promptVersion: "stub-1", schemaVersion: "1.0.0" });
    await createDraftVersion({
      workflowId: workflow.id,
      aiOutputId: draftAiOutputId,
      reportType: draftEnvelope.result.report_type,
      title: draftEnvelope.result.title,
      attendees: draftEnvelope.result.attendees,
      date: draftEnvelope.result.date,
      subject: draftEnvelope.result.subject,
      sections: draftEnvelope.result.sections,
      coverage: draftEnvelope.result.coverage,
      actionsPresent: draftEnvelope.result.actions_present,
    });
    await handleSkillOutput({ workflowId: workflow.id, envelope: draftQualityPrecheckEnvelope(), promptVersion: "stub-1", schemaVersion: "1.0.0" });
    await engine.transition({ workflowId: workflow.id, trigger: { kind: "user_action", action: "approve_draft" }, actor: { actorType: ActorType.USER, actorId: userId } });
    await handleSkillOutput({ workflowId: workflow.id, envelope: finalRendererEnvelope(), promptVersion: "stub-1", schemaVersion: "1.0.0" });

    const job = await prisma.job.findFirstOrThrow({ where: { workflowId: workflow.id, jobType: JobType.RUN_POST_PROCESSING } });
    await processUntilSettled(job.id);

    const results = await findPostProcessingResultsForWorkflow(workflow.id);
    const normCoverage = results.find((r) => r.skillKey === "norm_coverage");
    expect(normCoverage?.status).toBe(PostProcessingResultStatus.COMPLETED);
    expect(normCoverage?.aiOutputId).not.toBeNull();
    expect((normCoverage?.resultJson as { items: unknown[] }).items).toHaveLength(1);

    const completedWorkflow = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
    expect(completedWorkflow.currentState).toBe(WorkflowState.COMPLETED);
  });

  it("records a FAILED result (not a stuck workflow) when a follow-up skill errors, and still reaches COMPLETED", async () => {
    const workflowId = await driveToPostProcessing("Post-processing: failure path", FAILURE_MARKER);

    const job = await prisma.job.findFirstOrThrow({ where: { workflowId, jobType: JobType.RUN_POST_PROCESSING } });
    await processUntilSettled(job.id);

    const completedJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(completedJob.status).toBe(JobStatus.SUCCEEDED);

    const workflow = await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId } });
    expect(workflow.currentState).toBe(WorkflowState.COMPLETED);

    const results = await findPostProcessingResultsForWorkflow(workflowId);
    const openQuestions = results.find((r) => r.skillKey === "open_questions");
    expect(openQuestions?.status).toBe(PostProcessingResultStatus.FAILED);
    expect(openQuestions?.errorMessage).toContain("Simulated OpenQuestionsAnalyzer failure");
  });

  it("skips (rather than fails) a catalog row with no registered skill implementation", async () => {
    await prisma.postProcessingSkillPolicy.upsert({
      where: { key: "unregistered_future_skill" },
      update: { isActive: true },
      create: {
        key: "unregistered_future_skill",
        displayName: "Nog niet geïmplementeerd",
        promptRef: "does-not-exist.md",
        sortOrder: 99,
      },
    });
    try {
      const workflowId = await driveToPostProcessing("Post-processing: unregistered skill", "Onderwerp voor onbekende skill");

      const job = await prisma.job.findFirstOrThrow({ where: { workflowId, jobType: JobType.RUN_POST_PROCESSING } });
      await processUntilSettled(job.id);

      const results = await findPostProcessingResultsForWorkflow(workflowId);
      const unregistered = results.find((r) => r.skillKey === "unregistered_future_skill");
      expect(unregistered?.status).toBe(PostProcessingResultStatus.SKIPPED);

      const workflow = await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId } });
      expect(workflow.currentState).toBe(WorkflowState.COMPLETED);
    } finally {
      // Deactivate rather than delete: other concurrently-running test files
      // read the shared active catalog (real Postgres, per this suite's own
      // convention -- see tests/jobs/worker.test.ts's comment on
      // claimNextQueuedJob() claiming globally), so leaving an active row
      // behind (or deleting one referenced by a post_processing_results row
      // just written) risks affecting them.
      await prisma.postProcessingSkillPolicy.update({
        where: { key: "unregistered_future_skill" },
        data: { isActive: false },
      });
    }
  });
});
