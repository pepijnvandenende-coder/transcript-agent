import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { ActorType, JobStatus, JobType, PolicyType } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { retryApprovalRequest } from "../../src/approval/gateway";

// DraftGenerator (Phase 11), ReportTypeAdvisor (Phase 13), and
// DraftQualityPrecheck (Phase 14) all call the real Anthropic API -- mocked
// here so this real-Postgres integration suite stays network-free. All
// three skills share the same getAnthropicClient(), so the mock branches on
// the request's own output_config.format.schema (each skill asks for a
// differently-shaped structured output) rather than returning one fixed
// response for every call. The DraftGenerator branch's response includes
// both required Dutch section headings with non-empty content, plus a
// non-empty attendees list, since the downstream DraftQualityPrecheck job
// (also exercised below) now structurally validates title/attendees/date/
// subject too. The ReportTypeAdvisor branch returns "thematic", a key both
// report_type_policies rows seeded in beforeAll actually have.
vi.mock("../../src/ai/anthropicClient", () => ({
  getAnthropicClient: () => ({
    messages: {
      create: vi.fn().mockImplementation((params: { output_config?: { format?: { schema?: { properties?: Record<string, unknown> } } } }) => {
        const properties = params.output_config?.format?.schema?.properties ?? {};
        const isReportTypeClassification = "suggested_type" in properties;
        const isDraftQualityPrecheck = "checklist" in properties;
        if (isReportTypeClassification) {
          return Promise.resolve({
            content: [
              {
                type: "text",
                text: JSON.stringify({ suggested_type: "thematic", rationale: "Test rationale.", runner_up: "qa" }),
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
                  checklist: [
                    { item: "Deelnemers/datum/onderwerp correct overgenomen", passed: true },
                    { item: "Tekst feitelijk onderbouwd door brontekst", passed: true },
                  ],
                  blocking_issues: [],
                  recommendation: "Ziet er inhoudelijk correct uit.",
                }),
              },
            ],
          });
        }
        return Promise.resolve({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                title: "Gespreksverslag Test",
                attendees: ["Jan Jansen (projectleider)"],
                sections: [
                  { heading: "Samenvatting", content: "Kernpunten van het gesprek." },
                  { heading: "Notulen", content: "Gedetailleerde weergave van het gesprek." },
                ],
              }),
            },
          ],
        });
      }),
    },
  }),
}));
import { approveDraft, requestDraftChanges } from "../../src/approval/draftReview";
import { selectReportType } from "../../src/approval/reportTypeSelection";
import { env } from "../../src/config/env";
import { enqueue } from "../../src/jobs/queue";
import { processNextJob } from "../../src/jobs/worker";
import { prisma } from "../../src/persistence/prismaClient";
import { createNoteVersion } from "../../src/persistence/repositories/noteRepository";
import { createTranscriptVersion } from "../../src/persistence/repositories/transcriptRepository";
import { localFilesystemStorage } from "../../src/storage/localFilesystemStorage";
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

// claimNextQueuedJob() claims the globally oldest QUEUED job across every
// workflow, not just this test's own -- and other test files (e.g.
// gateway.test.ts, which enqueues jobs via auto-enqueue-on-state-entry but
// deliberately never processes them) run concurrently against the same
// database. Rather than assume a single processNextJob() call claims a
// specific job, poll until that job leaves QUEUED, tolerating unrelated jobs
// being claimed and processed (successfully or not) along the way. A single
// `false` result from processNextJob() is NOT treated as "queue is
// permanently empty" -- claimNextQueuedJob()'s own optimistic-lock retry
// contract (see persistence/repositories/jobRepository.ts) can legitimately
// return null on a lost claim race even when other QUEUED rows (including
// this one) still exist, so this keeps polling up to maxAttempts regardless.
async function processUntilSettled(jobId: string, maxAttempts = 50): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    if (job.status !== JobStatus.QUEUED) return;
    const didWork = await processNextJob();
    if (!didWork) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

describe("jobs: queue + processNextJob (no daemon required)", () => {
  let userId: string;
  let workflowId: string;

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
      where: { skillName: DRAFT_REVISER_SKILL_NAME },
      update: { policyType: PolicyType.MANDATORY, confidenceThreshold: null },
      create: { skillName: DRAFT_REVISER_SKILL_NAME, policyType: PolicyType.MANDATORY },
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
      data: { name: "Worker Test User", email: `worker-test-${randomUUID()}@example.com`, role: "reviewer" },
    });
    userId = user.id;

    const workflow = await engine.createWorkflow({ title: "Worker Test Workflow", createdById: userId });
    workflowId = workflow.id;
    await engine.transition({
      workflowId,
      trigger: { kind: "user_action", action: "upload_transcript" },
      actor: { actorType: ActorType.USER, actorId: userId },
    });
    await engine.transition({
      workflowId,
      trigger: { kind: "user_action", action: "submit_for_validation" },
      actor: { actorType: ActorType.USER, actorId: userId },
    });
  });

  afterAll(async () => {
    // Jobs and ai_outputs reference each other (jobs.result_ai_output_id <->
    // ai_outputs.job_id, jobs.retry_of_ai_output_id), and ai_output_inputs
    // references ai_outputs too, so all three are cleared before ai_outputs
    // rows are deleted.
    await prisma.stateTransition.deleteMany({ where: { OR: [{ actorId: userId }, { workflowId }] } });
    await prisma.approvalRequest.deleteMany({ where: { workflowId } });
    await prisma.job.updateMany({ where: { workflowId }, data: { resultAiOutputId: null, retryOfAiOutputId: null } });
    await prisma.merge.deleteMany({ where: { workflowId } });
    await prisma.aiOutputInput.deleteMany({ where: { aiOutput: { workflowId } } });
    await prisma.conflict.deleteMany({ where: { workflowId } });
    await prisma.reportTypeSuggestion.deleteMany({ where: { workflowId } });
    await prisma.draftPrecheck.deleteMany({ where: { workflowId } });
    await prisma.reviewFeedback.deleteMany({ where: { workflowId } });
    await prisma.finalReport.deleteMany({ where: { workflowId } });
    await prisma.draft.deleteMany({ where: { workflowId } });
    await prisma.aiOutput.deleteMany({ where: { workflowId } });
    await prisma.job.deleteMany({ where: { workflowId } });
    await prisma.transcript.deleteMany({ where: { workflowId } });
    await prisma.note.deleteMany({ where: { workflowId } });
    await prisma.workflow.delete({ where: { id: workflowId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
    rmSync(path.resolve(env.storageRootDir, workflowId), { recursive: true, force: true });
  });

  it("processNextJob claims, runs, and completes a queued VALIDATE_TRANSCRIPT job", async () => {
    const transcript = await createTranscriptVersion({
      workflowId,
      uploadedById: userId,
      content: "this transcript has plenty of words in it",
    });
    await createNoteVersion({ workflowId, uploadedById: userId, content: "some corroborating notes" });

    const job = await enqueue({ workflowId, jobType: JobType.VALIDATE_TRANSCRIPT, inputRef: transcript.id });
    expect(job.status).toBe(JobStatus.QUEUED);

    await processUntilSettled(job.id);

    const completed = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(completed.status).toBe(JobStatus.SUCCEEDED);
    expect(completed.resultAiOutputId).not.toBeNull();

    const workflow = await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId } });
    expect(workflow.currentState).toBe(WorkflowState.MERGING);
  });

  it("auto-approving VALIDATE_TRANSCRIPT auto-enqueued a MERGE job, which processNextJob also completes", async () => {
    // Continues from the previous test: entering MERGING auto-enqueued this
    // job via approval/gateway.ts's enqueueForStateEntry -- no explicit
    // "start merge" call is needed.
    const queuedMerge = await prisma.job.findFirstOrThrow({
      where: { workflowId, jobType: JobType.MERGE },
      orderBy: { createdAt: "desc" },
    });

    await processUntilSettled(queuedMerge.id);

    const completed = await prisma.job.findUniqueOrThrow({ where: { id: queuedMerge.id } });
    expect(completed.status).toBe(JobStatus.SUCCEEDED);
    expect(completed.resultAiOutputId).not.toBeNull();

    const workflow = await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId } });
    expect(workflow.currentState).toBe(WorkflowState.DETECTING_CONFLICTS);

    const merge = await prisma.merge.findFirstOrThrow({ where: { workflowId } });
    expect(merge.version).toBe(1);
    expect(merge.aiOutputId).toBe(completed.resultAiOutputId);
  });

  it("auto-approving MERGE auto-enqueued a DETECT_CONFLICTS job, which processNextJob also completes (no conflicts -- Merger's stub never produces unmatched notes)", async () => {
    // Continues from the previous test: entering DETECTING_CONFLICTS
    // auto-enqueued this job via the same enqueueForStateEntry mechanism.
    const queuedDetectConflicts = await prisma.job.findFirstOrThrow({
      where: { workflowId, jobType: JobType.DETECT_CONFLICTS },
      orderBy: { createdAt: "desc" },
    });

    await processUntilSettled(queuedDetectConflicts.id);

    const completed = await prisma.job.findUniqueOrThrow({ where: { id: queuedDetectConflicts.id } });
    expect(completed.status).toBe(JobStatus.SUCCEEDED);
    expect(completed.resultAiOutputId).not.toBeNull();

    const workflow = await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId } });
    expect(workflow.currentState).toBe(WorkflowState.SUGGESTING_REPORT_TYPE);

    const conflictCount = await prisma.conflict.count({ where: { workflowId } });
    expect(conflictCount).toBe(0);
  });

  it("auto-approving DETECT_CONFLICTS auto-enqueued a SUGGEST_REPORT_TYPE job, which processNextJob also completes", async () => {
    // Continues from the previous test: entering SUGGESTING_REPORT_TYPE
    // auto-enqueued this job via the same enqueueForStateEntry mechanism.
    // ReportTypeAdvisor's MANDATORY-unconditional policy means this always
    // proceeds to AWAITING_REPORT_TYPE_SELECTION regardless of confidence --
    // no threshold tuning needed for a deterministic outcome, unlike the
    // AUTO_IF_ABOVE skills above.
    const queuedSuggestReportType = await prisma.job.findFirstOrThrow({
      where: { workflowId, jobType: JobType.SUGGEST_REPORT_TYPE },
      orderBy: { createdAt: "desc" },
    });

    await processUntilSettled(queuedSuggestReportType.id);

    const completed = await prisma.job.findUniqueOrThrow({ where: { id: queuedSuggestReportType.id } });
    expect(completed.status).toBe(JobStatus.SUCCEEDED);
    expect(completed.resultAiOutputId).not.toBeNull();

    const workflow = await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId } });
    expect(workflow.currentState).toBe(WorkflowState.AWAITING_REPORT_TYPE_SELECTION);

    const suggestion = await prisma.reportTypeSuggestion.findFirstOrThrow({ where: { workflowId } });
    expect(suggestion.version).toBe(1);
    expect(suggestion.aiOutputId).toBe(completed.resultAiOutputId);
  });

  it("selecting a report type auto-enqueued a GENERATE_DRAFT job, which processNextJob also completes", async () => {
    // The real flow: approval/reportTypeSelection.ts's selectReportType()
    // validates against the catalog, sets workflows.reportType to the
    // resolved key, and (via enqueueForStateEntry) auto-starts
    // DraftGenerator's job the same way every other PROCESSING-state entry
    // does.
    const updated = await selectReportType({ workflowId, actorId: userId, reportType: "thematic" });
    expect(updated.currentState).toBe(WorkflowState.GENERATING_DRAFT);
    expect(updated.reportType).toBe("thematic");

    const queuedGenerateDraft = await prisma.job.findFirstOrThrow({
      where: { workflowId, jobType: JobType.GENERATE_DRAFT },
      orderBy: { createdAt: "desc" },
    });

    await processUntilSettled(queuedGenerateDraft.id);

    const completed = await prisma.job.findUniqueOrThrow({ where: { id: queuedGenerateDraft.id } });
    expect(completed.status).toBe(JobStatus.SUCCEEDED);
    expect(completed.resultAiOutputId).not.toBeNull();

    const workflow = await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId } });
    expect(workflow.currentState).toBe(WorkflowState.DRAFT_QUALITY_PRECHECK);

    const draft = await prisma.draft.findFirstOrThrow({ where: { workflowId } });
    expect(draft.version).toBe(1);
    expect(draft.aiOutputId).toBe(completed.resultAiOutputId);
    const sections = draft.sections as unknown as Array<{ heading: string }>;
    expect(sections.map((s) => s.heading)).toEqual(expect.arrayContaining(["Samenvatting", "Notulen"]));
  });

  it("entering DRAFT_QUALITY_PRECHECK auto-enqueued a DRAFT_QUALITY_PRECHECK job, which processNextJob also completes", async () => {
    // Continues from the previous test: entering DRAFT_QUALITY_PRECHECK
    // auto-enqueued this job via the same enqueueForStateEntry mechanism.
    // DraftQualityPrecheck's ADVISORY_ONLY policy means this always proceeds
    // to DRAFT_PENDING_REVIEW regardless of confidence, same as
    // SUGGEST_REPORT_TYPE's MANDATORY policy above.
    const queuedPrecheck = await prisma.job.findFirstOrThrow({
      where: { workflowId, jobType: JobType.DRAFT_QUALITY_PRECHECK },
      orderBy: { createdAt: "desc" },
    });

    await processUntilSettled(queuedPrecheck.id);

    const completed = await prisma.job.findUniqueOrThrow({ where: { id: queuedPrecheck.id } });
    expect(completed.status).toBe(JobStatus.SUCCEEDED);
    expect(completed.resultAiOutputId).not.toBeNull();

    const workflow = await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId } });
    expect(workflow.currentState).toBe(WorkflowState.DRAFT_PENDING_REVIEW);

    const precheck = await prisma.draftPrecheck.findFirstOrThrow({ where: { workflowId } });
    expect(precheck.aiOutputId).toBe(completed.resultAiOutputId);
    expect(precheck.overallScore).toBe(1);
    expect(precheck.blockingIssues).toEqual([]);
  });

  it("requestDraftChanges auto-enqueued a REVISE_DRAFT job, which processNextJob also completes, producing a second draft version", async () => {
    // The real flow: approval/draftReview.ts's requestDraftChanges() records
    // the feedback and (via enqueueForStateEntry) auto-starts DraftReviser's
    // job the same way every other PROCESSING-state entry does.
    const draftBeforeRevision = await prisma.draft.findFirstOrThrow({ where: { workflowId }, orderBy: { version: "desc" } });

    const updated = await requestDraftChanges({
      workflowId,
      actorId: userId,
      version: draftBeforeRevision.version,
      feedback: "Voeg meer detail toe over de genomen besluiten.",
    });
    expect(updated.currentState).toBe(WorkflowState.REVISING_DRAFT);

    const queuedRevise = await prisma.job.findFirstOrThrow({
      where: { workflowId, jobType: JobType.REVISE_DRAFT },
      orderBy: { createdAt: "desc" },
    });

    await processUntilSettled(queuedRevise.id);

    const completed = await prisma.job.findUniqueOrThrow({ where: { id: queuedRevise.id } });
    expect(completed.status).toBe(JobStatus.SUCCEEDED);
    expect(completed.resultAiOutputId).not.toBeNull();

    const workflow = await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId } });
    expect(workflow.currentState).toBe(WorkflowState.DRAFT_QUALITY_PRECHECK);

    const revisedDraft = await prisma.draft.findFirstOrThrow({ where: { workflowId }, orderBy: { version: "desc" } });
    expect(revisedDraft.version).toBe(draftBeforeRevision.version + 1);
    expect(revisedDraft.aiOutputId).toBe(completed.resultAiOutputId);
    const sections = revisedDraft.sections as unknown as Array<{ heading: string; content: string }>;
    const notulen = sections.find((s) => s.heading === "Notulen");
    expect(notulen?.content).toContain("Voeg meer detail toe over de genomen besluiten.");
  });

  it("entering DRAFT_QUALITY_PRECHECK for the revised draft auto-enqueued a DRAFT_QUALITY_PRECHECK job, which processNextJob also completes", async () => {
    // Continues from the previous test: REVISE_DRAFT completing landed back
    // on DRAFT_QUALITY_PRECHECK (per the revision loop), auto-enqueuing a
    // fresh precheck job for the v2 draft via the same enqueueForStateEntry
    // mechanism.
    const queuedPrecheck = await prisma.job.findFirstOrThrow({
      where: { workflowId, jobType: JobType.DRAFT_QUALITY_PRECHECK },
      orderBy: { createdAt: "desc" },
    });

    await processUntilSettled(queuedPrecheck.id);

    const completed = await prisma.job.findUniqueOrThrow({ where: { id: queuedPrecheck.id } });
    expect(completed.status).toBe(JobStatus.SUCCEEDED);

    const workflow = await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId } });
    expect(workflow.currentState).toBe(WorkflowState.DRAFT_PENDING_REVIEW);
  });

  it("approveDraft auto-enqueued a RENDER_FINAL job, which processNextJob also completes, reaching COMPLETED with a final report", async () => {
    // The real flow: approval/draftReview.ts's approveDraft() finalizes the
    // draft's ai_output and (via enqueueForStateEntry) auto-starts
    // FinalRenderer's job the same way every other PROCESSING-state entry
    // does. This is the last skill in the pipeline -- the workflow reaches
    // its terminal state here.
    const draft = await prisma.draft.findFirstOrThrow({ where: { workflowId }, orderBy: { version: "desc" } });

    const updated = await approveDraft({ workflowId, actorId: userId, version: draft.version });
    expect(updated.currentState).toBe(WorkflowState.GENERATING_FINAL);

    const queuedRender = await prisma.job.findFirstOrThrow({
      where: { workflowId, jobType: JobType.RENDER_FINAL },
      orderBy: { createdAt: "desc" },
    });

    await processUntilSettled(queuedRender.id);

    const completed = await prisma.job.findUniqueOrThrow({ where: { id: queuedRender.id } });
    expect(completed.status).toBe(JobStatus.SUCCEEDED);
    expect(completed.resultAiOutputId).not.toBeNull();

    const workflow = await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId } });
    expect(workflow.currentState).toBe(WorkflowState.COMPLETED);
    expect(workflow.status).toBe("COMPLETED");

    const finalReport = await prisma.finalReport.findUniqueOrThrow({ where: { workflowId } });
    expect(finalReport.draftId).toBe(draft.id);
    expect(finalReport.aiOutputId).toBe(completed.resultAiOutputId);

    const content = await localFilesystemStorage.get(finalReport.storageRef);
    expect(content).toContain("Voeg meer detail toe over de genomen besluiten.");
  });

  it("retry lineage flows from a manually-enqueued retry job through to the resulting ai_outputs row", async () => {
    // Uses its own workflow rather than the shared one above, since this
    // exercises VALIDATE_TRANSCRIPT from a fresh VALIDATING_TRANSCRIPT state.
    const retryUser = await prisma.user.create({
      data: { name: "Retry Lineage User", email: `retry-lineage-${randomUUID()}@example.com`, role: "reviewer" },
    });
    const workflow = await engine.createWorkflow({ title: "Retry Lineage Workflow", createdById: retryUser.id });
    await engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "upload_transcript" },
      actor: { actorType: ActorType.USER, actorId: retryUser.id },
    });
    await engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "submit_for_validation" },
      actor: { actorType: ActorType.USER, actorId: retryUser.id },
    });
    const transcript = await createTranscriptVersion({
      workflowId: workflow.id,
      uploadedById: retryUser.id,
      content: "the first attempt's transcript content",
    });

    // TranscriptQualityChecker's stub always reports confidence 0.9 for
    // non-empty content (fixed, per Phase 2) -- temporarily raise the
    // threshold above that so the first run opens a real checkpoint instead
    // of auto-approving, mirroring Phase 2's own manual-verification
    // workaround for this same fixed-value stub. This also means the retried
    // attempt (still 0.9, still below 0.95) reopens a checkpoint rather than
    // reaching MERGING, so this test never touches the Merger/job-queue
    // interaction that gateway.test.ts and the MERGE-job tests above already cover.
    await prisma.approvalPolicy.update({ where: { skillName: SKILL_NAME }, data: { confidenceThreshold: 0.95 } });
    try {
      const firstJob = await enqueue({
        workflowId: workflow.id,
        jobType: JobType.VALIDATE_TRANSCRIPT,
        inputRef: transcript.id,
      });
      await processUntilSettled(firstJob.id);
      const completedFirstJob = await prisma.job.findUniqueOrThrow({ where: { id: firstJob.id } });
      expect(completedFirstJob.status).toBe(JobStatus.SUCCEEDED);
      const firstOutput = await prisma.aiOutput.findUniqueOrThrow({
        where: { id: completedFirstJob.resultAiOutputId! },
      });
      expect(firstOutput.attemptNumber).toBe(1);

      const afterFirst = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
      expect(afterFirst.currentState).toBe(WorkflowState.PENDING_HUMAN_CONFIRMATION);

      // The real retry path: routes back through VALIDATING_TRANSCRIPT and
      // enqueues the retry job itself (approval/gateway.ts's enqueueForStateEntry) --
      // this test only asserts what processNextJob() does with that job.
      const retried = await retryApprovalRequest({ workflowId: workflow.id, actorId: retryUser.id });
      expect(retried.currentState).toBe(WorkflowState.VALIDATING_TRANSCRIPT);

      const retryJob = await prisma.job.findFirstOrThrow({
        where: { workflowId: workflow.id, jobType: JobType.VALIDATE_TRANSCRIPT, retryOfAiOutputId: firstOutput.id },
      });
      await processUntilSettled(retryJob.id);

      const completedRetryJob = await prisma.job.findUniqueOrThrow({ where: { id: retryJob.id } });
      expect(completedRetryJob.status).toBe(JobStatus.SUCCEEDED);
      const retryOutput = await prisma.aiOutput.findUniqueOrThrow({
        where: { id: completedRetryJob.resultAiOutputId! },
      });
      expect(retryOutput.attemptNumber).toBe(2);
      expect(retryOutput.retryOfAiOutputId).toBe(firstOutput.id);
      expect(retryOutput.retryMode).toBe("SAME_INPUT");
    } finally {
      await prisma.approvalPolicy.update({ where: { skillName: SKILL_NAME }, data: { confidenceThreshold: 0.75 } });
    }

    // Cleanup for this test's own dedicated workflow/user.
    await prisma.stateTransition.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.approvalRequest.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.job.updateMany({
      where: { workflowId: workflow.id },
      data: { resultAiOutputId: null, retryOfAiOutputId: null },
    });
    await prisma.aiOutputInput.deleteMany({ where: { aiOutput: { workflowId: workflow.id } } });
    await prisma.merge.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.aiOutput.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.job.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.transcript.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.workflow.delete({ where: { id: workflow.id } });
    await prisma.user.delete({ where: { id: retryUser.id } });
    rmSync(path.resolve(env.storageRootDir, workflow.id), { recursive: true, force: true });
  });

  it("Phase 13: a transcript-only workflow (no notes) never opens PENDING_HUMAN_CONFIRMATION and skips the ConflictDetector call", async () => {
    // Uses its own dedicated workflow/user, same pattern as the retry
    // lineage test above -- this specifically needs a workflow with NO
    // notes uploaded, unlike the shared workflow at the top of this file.
    const noNotesUser = await prisma.user.create({
      data: { name: "No Notes User", email: `no-notes-${randomUUID()}@example.com`, role: "reviewer" },
    });
    const workflow = await engine.createWorkflow({ title: "No Notes Workflow", createdById: noNotesUser.id });
    await engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "upload_transcript" },
      actor: { actorType: ActorType.USER, actorId: noNotesUser.id },
    });
    await engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "submit_for_validation" },
      actor: { actorType: ActorType.USER, actorId: noNotesUser.id },
    });
    const transcript = await createTranscriptVersion({
      workflowId: workflow.id,
      uploadedById: noNotesUser.id,
      content: "a transcript with no accompanying notes at all",
    });

    const validateJob = await enqueue({ workflowId: workflow.id, jobType: JobType.VALIDATE_TRANSCRIPT, inputRef: transcript.id });
    await processUntilSettled(validateJob.id);
    const afterValidate = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
    expect(afterValidate.currentState).toBe(WorkflowState.MERGING);

    const mergeJob = await prisma.job.findFirstOrThrow({ where: { workflowId: workflow.id, jobType: JobType.MERGE } });
    await processUntilSettled(mergeJob.id);
    const afterMerge = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
    // The core Phase 13 fix: without notes, Merger's own confidence (0.65,
    // below the 0.80 threshold) must NOT open PENDING_HUMAN_CONFIRMATION --
    // it auto-approves straight through, per policyResolver.ts's Merger hook.
    expect(afterMerge.currentState).toBe(WorkflowState.DETECTING_CONFLICTS);
    const mergeOutput = await prisma.aiOutput.findUniqueOrThrow({
      where: { id: (await prisma.job.findUniqueOrThrow({ where: { id: mergeJob.id } })).resultAiOutputId! },
    });
    expect(mergeOutput.confidenceScore).toBeLessThan(0.8);

    const detectJob = await prisma.job.findFirstOrThrow({ where: { workflowId: workflow.id, jobType: JobType.DETECT_CONFLICTS } });
    await processUntilSettled(detectJob.id);
    const afterDetect = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
    expect(afterDetect.currentState).toBe(WorkflowState.SUGGESTING_REPORT_TYPE);
    const detectOutput = await prisma.aiOutput.findUniqueOrThrow({
      where: { id: (await prisma.job.findUniqueOrThrow({ where: { id: detectJob.id } })).resultAiOutputId! },
    });
    // Confirms conflictDetectionRunner.ts actually skipped calling
    // ai/skills/conflictDetector.ts, rather than merely happening to
    // auto-approve -- the flag only appears on the skipped path.
    expect((detectOutput.rawOutput as { flags: string[] }).flags).toContain("no_notes_to_compare");

    // Never touched PENDING_HUMAN_CONFIRMATION at any point in this run.
    const history = await prisma.stateTransition.findMany({ where: { workflowId: workflow.id } });
    expect(history.map((h) => h.toState)).not.toContain(WorkflowState.PENDING_HUMAN_CONFIRMATION);

    await prisma.stateTransition.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.job.updateMany({ where: { workflowId: workflow.id }, data: { resultAiOutputId: null } });
    await prisma.merge.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.aiOutputInput.deleteMany({ where: { aiOutput: { workflowId: workflow.id } } });
    await prisma.aiOutput.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.job.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.transcript.deleteMany({ where: { workflowId: workflow.id } });
    await prisma.workflow.delete({ where: { id: workflow.id } });
    await prisma.user.delete({ where: { id: noNotesUser.id } });
    rmSync(path.resolve(env.storageRootDir, workflow.id), { recursive: true, force: true });
  });
});
