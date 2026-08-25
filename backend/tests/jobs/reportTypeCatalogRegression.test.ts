import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { ActorType, JobStatus, JobType, PolicyType } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Regression coverage for a real incident: tests/jobs/draftActionsConsistency.test.ts
// used to upsert a fabricated third report_type_policies row
// ("thematic_actions" / "Thematisch gespreksverslag (met acties)") into the
// shared Postgres database and never cleaned it up, so it leaked into
// GET /report-type-policies, ReportTypeAdvisor's catalog, and the frontend
// picker permanently -- three options where there must only ever be two.
//
// Architecture this file locks in: "Acties en vervolgstappen" is an OPTIONAL
// SECTION of both real report types (thematic, qa), never its own report
// type or a variant of one. actionsPresent must never influence which report
// type exists, is suggested, or is stored -- it only controls whether the
// optional actions section is included in whichever report type the human
// actually chose.
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
              content: [{ type: "text", text: JSON.stringify({ suggested_type: "thematic", rationale: "x", runner_up: "qa" }) }],
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

          // DraftGenerator -- actions_present is decided purely from the
          // source content, never from (and never influencing) which report
          // type was selected.
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

import { createApp } from "../../src/api/app";
import * as reportTypeAdvisor from "../../src/ai/skills/reportTypeAdvisor";
import { selectReportType } from "../../src/approval/reportTypeSelection";
import { env } from "../../src/config/env";
import { enqueue } from "../../src/jobs/queue";
import { processNextJob } from "../../src/jobs/worker";
import { prisma } from "../../src/persistence/prismaClient";
import { findActivePolicies } from "../../src/persistence/repositories/reportTypePolicyRepository";
import { createNoteVersion } from "../../src/persistence/repositories/noteRepository";
import { createTranscriptVersion } from "../../src/persistence/repositories/transcriptRepository";
import * as engine from "../../src/workflow/engine";
import { WorkflowState } from "../../src/workflow/states";

const CANONICAL_KEYS = ["qa", "thematic"];
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

async function assertExactlyTwoCanonicalPolicies() {
  const policies = await findActivePolicies();
  expect(policies.map((policy) => policy.key).sort()).toEqual(CANONICAL_KEYS);
}

/**
 * Drives a fresh workflow all the way from upload through DRAFT_PENDING_REVIEW
 * via the real job queue, selecting `reportType` explicitly (never the AI's
 * suggestion), and returns the persisted workflow/draft rows.
 */
async function runPipeline(params: { userId: string; title: string; transcriptContent: string; reportType: string }) {
  const { userId, title, transcriptContent, reportType } = params;

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

  await selectReportType({ workflowId: workflow.id, actorId: userId, reportType });

  const generateJob = await prisma.job.findFirstOrThrow({ where: { workflowId: workflow.id, jobType: JobType.GENERATE_DRAFT }, orderBy: { createdAt: "desc" } });
  await processUntilSettled(generateJob.id);

  const precheckJob = await prisma.job.findFirstOrThrow({ where: { workflowId: workflow.id, jobType: JobType.DRAFT_QUALITY_PRECHECK }, orderBy: { createdAt: "desc" } });
  await processUntilSettled(precheckJob.id);

  const workflowAfter = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
  expect(workflowAfter.currentState).toBe(WorkflowState.DRAFT_PENDING_REVIEW);

  const draft = await prisma.draft.findFirstOrThrow({ where: { workflowId: workflow.id }, orderBy: { version: "desc" } });

  return { workflowId: workflow.id, workflow: workflowAfter, draft };
}

// Requires a real Postgres database -- see docs/phase-1/README.md.
describe("Report type catalog stays exactly {thematic, qa} regardless of actionsPresent", () => {
  let userId: string;
  let server: Server;
  let baseUrl: string;
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

    // Idempotent -- reasserts the two real catalog rows without ever
    // fabricating a third one, matching every sibling real-Postgres test.
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
        optionalSections: ["Acties en vervolgstappen"],
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
        optionalSections: ["Acties en vervolgstappen"],
        bodyContentRule: { type: "qa_pairs", minCount: 1 },
      },
    });

    const user = await prisma.user.create({
      data: { name: "Report Type Catalog Regression User", email: `report-type-catalog-regression-${randomUUID()}@example.com`, role: "reviewer" },
    });
    userId = user.id;

    server = createApp().listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
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

  // Requirement A
  it("A: GET /report-type-policies returns exactly the two real report types, never a third", async () => {
    const response = await fetch(`${baseUrl}/report-type-policies`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<{ key: string; displayName: string }>;

    expect(body).toHaveLength(2);
    expect(body.map((policy) => policy.key).sort()).toEqual(CANONICAL_KEYS);
    expect(body.map((policy) => policy.displayName).sort()).toEqual(
      ["Thematisch gespreksverslag", "Vraag & antwoord gespreksverslag"].sort(),
    );
    // Guards specifically against the leaked variant reappearing.
    expect(body.some((policy) => policy.displayName.includes("met acties"))).toBe(false);
  });

  // Requirement B
  it("B: ReportTypeAdvisor's structured-output schema can only ever return thematic or qa, using the real active catalog", async () => {
    const policies = await findActivePolicies();
    expect(policies.map((p) => p.key).sort()).toEqual(CANONICAL_KEYS);

    const envelope = await reportTypeAdvisor.run("Vraag: wat is de voortgang? Antwoord: op schema.", {
      policies: policies.map((p) => ({ key: p.key, displayName: p.displayName })),
    });

    expect(["thematic", "qa"]).toContain(envelope.result.suggested_type);
    expect(["thematic", "qa"]).toContain(envelope.result.runner_up);
  });

  // Requirements D/E/F/G: both report types, with and without actionsPresent,
  // are all individually valid and never produce a third report type.
  it.each([
    { label: "D: thematic + actionsPresent=false", reportType: "thematic", hasActions: false },
    { label: "E: thematic + actionsPresent=true", reportType: "thematic", hasActions: true },
    { label: "F: qa + actionsPresent=false", reportType: "qa", hasActions: false },
    { label: "G: qa + actionsPresent=true", reportType: "qa", hasActions: true },
  ])("$label", async ({ reportType, hasActions }) => {
    const transcriptContent = hasActions
      ? `Kort overleg over de voortgang. ${ACTIONS_MARKER}`
      : "Kort overleg over de voortgang, verder niets afgesproken.";

    const { workflowId, workflow, draft } = await runPipeline({
      userId,
      title: `Catalog Regression - ${reportType} - actions:${hasActions}`,
      transcriptContent,
      reportType,
    });
    workflowIds.push(workflowId);

    // The report type is exactly what was selected -- never a variant.
    expect(workflow.reportType).toBe(reportType);
    expect(draft.reportType).toBe(reportType);
    expect(draft.actionsPresent).toBe(hasActions);

    const sections = draft.sections as unknown as Array<{ heading: string }>;
    expect(sections.some((section) => section.heading === "Acties en vervolgstappen")).toBe(hasActions);
  });

  // Requirement H
  it("H: none of the above scenarios ever create a third report type in the catalog", async () => {
    await assertExactlyTwoCanonicalPolicies();
  });

  // Requirement I
  it("I: actionsPresent has no influence on which report type is stored -- same type, both actionsPresent values, both selectable", async () => {
    const noActions = await runPipeline({
      userId,
      title: "Catalog Regression - I - thematic no actions",
      transcriptContent: "Alleen een informatief overleg, verder niets afgesproken.",
      reportType: "thematic",
    });
    workflowIds.push(noActions.workflowId);
    const hasActions = await runPipeline({
      userId,
      title: "Catalog Regression - I - thematic with actions",
      transcriptContent: `Kort overleg. ${ACTIONS_MARKER}`,
      reportType: "thematic",
    });
    workflowIds.push(hasActions.workflowId);

    expect(noActions.draft.reportType).toBe("thematic");
    expect(hasActions.draft.reportType).toBe("thematic");
    expect(noActions.draft.actionsPresent).toBe(false);
    expect(hasActions.draft.actionsPresent).toBe(true);

    await assertExactlyTwoCanonicalPolicies();
  });
});
