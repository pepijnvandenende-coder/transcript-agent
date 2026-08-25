import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { ActorType, JobStatus, JobType, PolicyType } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Requirement G: this file proves DraftQualityPrecheck and DraftGenerator can
// never draw a different conclusion about whether the source contains
// concrete actions/vervolgstappen, by running the REAL runners
// (draftGenerationRunner.ts, draftQualityPrecheckRunner.ts) through the real
// job queue -- not by hand-building consistent envelopes (which would prove
// nothing about the wiring itself).
//
// Same mocking convention as tests/jobs/worker.test.ts: getAnthropicClient()
// is shared by every LLM-calling skill, so this branches on the requested
// structured-output schema's own properties. The DraftGenerator branch
// additionally inspects the outgoing user message for ACTIONS_MARKER (only
// present in one of the two transcripts used below) to decide whether its
// mocked response reports actions_present true or false -- this is the one
// and only place in this whole pipeline that "decides" whether actions
// exist, exactly like the real model is meant to be the one place that
// decides it.
const ACTIONS_MARKER = "Jan zegt toe het verslag na afloop rond te sturen.";

vi.mock("../../src/ai/anthropicClient", () => ({
  getAnthropicClient: () => ({
    messages: {
      create: vi.fn().mockImplementation(
        (params: {
          output_config?: { format?: { schema?: { properties?: Record<string, unknown> } } };
          messages: Array<{ content: string }>;
        }) => {
          const properties = params.output_config?.format?.schema?.properties ?? {};
          const isReportTypeClassification = "suggested_type" in properties;
          const isDraftQualityPrecheck = "factually_grounded" in properties;

          if (isReportTypeClassification) {
            return Promise.resolve({
              content: [{ type: "text", text: JSON.stringify({ suggested_type: "thematic_actions", rationale: "x", runner_up: "qa" }) }],
            });
          }
          if (isDraftQualityPrecheck) {
            // Deliberately never asked (and never answers) whether actions
            // are present -- see draftQualityPrecheck.ts/draftQualityPrecheck.md.
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

          // DraftGenerator -- the ONE place this mock decides actions_present,
          // based on whether the source it was actually given contains the
          // marker, exactly the judgment ACTIONS_PRESENCE_INSTRUCTIONS asks
          // the real model to make.
          const userMessage = params.messages[0].content;
          const hasActions = userMessage.includes(ACTIONS_MARKER);
          return Promise.resolve({
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  title: "Gespreksverslag Test",
                  attendees: ["Jan Jansen (projectleider)"],
                  conversation_date: "2026-01-15",
                  sections: hasActions
                    ? [
                        { heading: "Samenvatting", content: "Kernpunten van het gesprek." },
                        { heading: "Notulen", content: "Gedetailleerde weergave van het gesprek." },
                        {
                          heading: "Acties en vervolgstappen",
                          content:
                            "| Actie | Verantwoordelijke | Deadline | Status |\n|---|---|---|---|\n| Jan stuurt het verslag na afloop rond | Jan |  | Open |",
                        },
                      ]
                    : [
                        { heading: "Samenvatting", content: "Kernpunten van het gesprek." },
                        { heading: "Notulen", content: "Gedetailleerde weergave van het gesprek." },
                      ],
                  actions_present: hasActions,
                }),
              },
            ],
          });
        },
      ),
    },
  }),
}));

import { selectReportType } from "../../src/approval/reportTypeSelection";
import { env } from "../../src/config/env";
import { enqueue } from "../../src/jobs/queue";
import { processNextJob } from "../../src/jobs/worker";
import { prisma } from "../../src/persistence/prismaClient";
import { createNoteVersion } from "../../src/persistence/repositories/noteRepository";
import { createTranscriptVersion } from "../../src/persistence/repositories/transcriptRepository";
import * as engine from "../../src/workflow/engine";
import { WorkflowState } from "../../src/workflow/states";

const REPORT_TYPE_KEY = "thematic_actions";
const SKILL_NAMES = ["TranscriptQualityChecker", "Merger", "ConflictDetector", "ReportTypeAdvisor", "DraftGenerator", "DraftQualityPrecheck"];

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

/**
 * Drives a fresh workflow all the way from upload through DRAFT_QUALITY_PRECHECK
 * via the real job queue (not hand-fed envelopes), returning the persisted
 * Draft and DraftPrecheck rows so the two can be compared directly.
 */
async function runPipeline(params: { userId: string; title: string; transcriptContent: string }) {
  const { userId, title, transcriptContent } = params;

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

  const transcript = await createTranscriptVersion({ workflowId: workflow.id, uploadedById: userId, content: transcriptContent });
  await createNoteVersion({ workflowId: workflow.id, uploadedById: userId, content: "geen aanvullende notities" });

  const validateJob = await enqueue({ workflowId: workflow.id, jobType: JobType.VALIDATE_TRANSCRIPT, inputRef: transcript.id });
  await processUntilSettled(validateJob.id);

  const mergeJob = await prisma.job.findFirstOrThrow({ where: { workflowId: workflow.id, jobType: JobType.MERGE }, orderBy: { createdAt: "desc" } });
  await processUntilSettled(mergeJob.id);

  const conflictsJob = await prisma.job.findFirstOrThrow({ where: { workflowId: workflow.id, jobType: JobType.DETECT_CONFLICTS }, orderBy: { createdAt: "desc" } });
  await processUntilSettled(conflictsJob.id);

  const suggestJob = await prisma.job.findFirstOrThrow({ where: { workflowId: workflow.id, jobType: JobType.SUGGEST_REPORT_TYPE }, orderBy: { createdAt: "desc" } });
  await processUntilSettled(suggestJob.id);

  await selectReportType({ workflowId: workflow.id, actorId: userId, reportType: REPORT_TYPE_KEY });

  const generateJob = await prisma.job.findFirstOrThrow({ where: { workflowId: workflow.id, jobType: JobType.GENERATE_DRAFT }, orderBy: { createdAt: "desc" } });
  await processUntilSettled(generateJob.id);

  const precheckJob = await prisma.job.findFirstOrThrow({ where: { workflowId: workflow.id, jobType: JobType.DRAFT_QUALITY_PRECHECK }, orderBy: { createdAt: "desc" } });
  await processUntilSettled(precheckJob.id);

  const workflowAfter = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
  expect(workflowAfter.currentState).toBe(WorkflowState.DRAFT_PENDING_REVIEW);

  const draft = await prisma.draft.findFirstOrThrow({ where: { workflowId: workflow.id }, orderBy: { version: "desc" } });
  const precheck = await prisma.draftPrecheck.findFirstOrThrow({ where: { workflowId: workflow.id } });

  return { workflowId: workflow.id, draft, precheck };
}

function actionsChecklistItem(checklist: unknown): { item: string; status: string; detail: string } | undefined {
  return (checklist as Array<{ item: string; status: string; detail: string }>).find((entry) => entry.item === "Acties en vervolgstappen");
}

// Requires a real Postgres database -- see docs/phase-1/README.md.
describe("DraftGenerator/DraftQualityPrecheck actions consistency (real job queue, mocked LLM)", () => {
  let userId: string;
  const workflowIds: string[] = [];

  beforeAll(async () => {
    await Promise.all(
      SKILL_NAMES.map((skillName) => {
        const isMandatory = ["ReportTypeAdvisor", "DraftGenerator"].includes(skillName);
        const isAdvisory = skillName === "DraftQualityPrecheck";
        const policyType = isMandatory ? PolicyType.MANDATORY : isAdvisory ? PolicyType.ADVISORY_ONLY : PolicyType.AUTO_IF_ABOVE;
        const confidenceThreshold = policyType === PolicyType.AUTO_IF_ABOVE ? 0.5 : null;
        return prisma.approvalPolicy.upsert({
          where: { skillName },
          update: { policyType, confidenceThreshold },
          create: { skillName, policyType, confidenceThreshold },
        });
      }),
    );

    await prisma.reportTypePolicy.upsert({
      where: { key: REPORT_TYPE_KEY },
      update: {},
      create: {
        key: REPORT_TYPE_KEY,
        displayName: "Thematisch gespreksverslag (met acties)",
        language: "nl",
        promptVersion: "v1",
        promptRef: "thematic.md",
        requiredSections: ["Samenvatting"],
        optionalSections: ["Acties en vervolgstappen"],
        bodyContentRule: { type: "topic_sections", minCount: 1 },
      },
    });

    const user = await prisma.user.create({
      data: { name: "Actions Consistency Test User", email: `actions-consistency-test-${randomUUID()}@example.com`, role: "reviewer" },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.stateTransition.deleteMany({ where: { OR: [{ actorId: userId }, { workflowId: { in: workflowIds } }] } });
    await prisma.approvalRequest.deleteMany({ where: { workflowId: { in: workflowIds } } });
    await prisma.job.updateMany({ where: { workflowId: { in: workflowIds } }, data: { resultAiOutputId: null, retryOfAiOutputId: null } });
    await prisma.merge.deleteMany({ where: { workflowId: { in: workflowIds } } });
    await prisma.aiOutputInput.deleteMany({ where: { aiOutput: { workflowId: { in: workflowIds } } } });
    await prisma.conflict.deleteMany({ where: { workflowId: { in: workflowIds } } });
    await prisma.reportTypeSuggestion.deleteMany({ where: { workflowId: { in: workflowIds } } });
    await prisma.draftPrecheck.deleteMany({ where: { workflowId: { in: workflowIds } } });
    await prisma.draft.deleteMany({ where: { workflowId: { in: workflowIds } } });
    await prisma.aiOutput.deleteMany({ where: { workflowId: { in: workflowIds } } });
    await prisma.job.deleteMany({ where: { workflowId: { in: workflowIds } } });
    await prisma.transcript.deleteMany({ where: { workflowId: { in: workflowIds } } });
    await prisma.note.deleteMany({ where: { workflowId: { in: workflowIds } } });
    await prisma.workflow.deleteMany({ where: { id: { in: workflowIds } } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
    for (const workflowId of workflowIds) {
      rmSync(path.resolve(env.storageRootDir, workflowId), { recursive: true, force: true });
    }
  });

  it("scenario A: no actions in the source -- precheck says 'geen concrete acties' and the draft has no actions section", async () => {
    const { workflowId, draft, precheck } = await runPipeline({
      userId,
      title: "Actions Consistency - No Actions",
      transcriptContent: "We bespraken de voortgang van het project. Alles verliep zoals gepland, geen bijzonderheden.",
    });
    workflowIds.push(workflowId);

    expect(draft.actionsPresent).toBe(false);
    const sections = draft.sections as unknown as Array<{ heading: string }>;
    expect(sections.some((section) => section.heading === "Acties en vervolgstappen")).toBe(false);

    const checklist = precheck.checklist as unknown;
    expect(actionsChecklistItem(checklist)).toEqual({
      item: "Acties en vervolgstappen",
      status: "info",
      detail: "Geen concrete acties of vervolgstappen gevonden in het transcript.",
    });
  });

  it("scenario B: a concrete action in the source -- precheck says 'ok' and the draft contains the same action", async () => {
    const { workflowId, draft, precheck } = await runPipeline({
      userId,
      title: "Actions Consistency - Has Action",
      transcriptContent: `We bespraken de voortgang van het project. ${ACTIONS_MARKER}`,
    });
    workflowIds.push(workflowId);

    expect(draft.actionsPresent).toBe(true);
    const sections = draft.sections as unknown as Array<{ heading: string; content: string }>;
    const actionsSection = sections.find((section) => section.heading === "Acties en vervolgstappen");
    expect(actionsSection?.content).toContain("Jan stuurt het verslag na afloop rond");

    const checklist = precheck.checklist as unknown;
    expect(actionsChecklistItem(checklist)?.status).toBe("ok");
  });

  // The consistency requirement itself, stated directly rather than just
  // implied by the two scenarios above: whatever DraftGenerator decided is
  // exactly what DraftQualityPrecheck reports, for both possible answers.
  it("scenario G: the precheck's actions conclusion always matches draft.actionsPresent, never its own independent judgment", async () => {
    const noActions = await runPipeline({
      userId,
      title: "Actions Consistency - G No Actions",
      transcriptContent: "Alleen een informatief overleg, verder niets afgesproken.",
    });
    workflowIds.push(noActions.workflowId);
    const hasActions = await runPipeline({
      userId,
      title: "Actions Consistency - G Has Action",
      transcriptContent: `Kort overleg. ${ACTIONS_MARKER}`,
    });
    workflowIds.push(hasActions.workflowId);

    const noActionsItem = actionsChecklistItem(noActions.precheck.checklist as unknown);
    const hasActionsItem = actionsChecklistItem(hasActions.precheck.checklist as unknown);

    expect(noActions.draft.actionsPresent).toBe(false);
    expect(noActionsItem?.status).not.toBe("ok");
    expect(noActionsItem?.status).toBe("info");

    expect(hasActions.draft.actionsPresent).toBe(true);
    expect(hasActionsItem?.status).toBe("ok");
  });
});
