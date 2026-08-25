import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PolicyType, PostProcessingResultStatus, ValidationStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app";
import { prisma } from "../../src/persistence/prismaClient";
import * as engine from "../../src/workflow/engine";

// Requires a real Postgres database -- see docs/phase-1/README.md. Exercises
// the Phase 18 read-side of post-processing: GET /workflows/:id/post-processing-results
// and GET /post-processing-policies. Results are inserted directly via
// Prisma here (bypassing the real job queue/postProcessingRunner.ts, which
// tests/jobs/postProcessingRunner.test.ts already covers end-to-end) --
// this file is only about whether the HTTP routes serialize/retrieve
// correctly.
describe("post-processing routes (Phase 18)", () => {
  let userId: string;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    await prisma.postProcessingSkillPolicy.upsert({
      where: { key: "open_questions" },
      update: { isActive: true },
      create: { key: "open_questions", displayName: "Openstaande vragen", promptRef: "openQuestions.md", sortOrder: 1 },
    });
    await prisma.postProcessingSkillPolicy.upsert({
      where: { key: "postprocessing-routes-test-inactive" },
      update: { isActive: false },
      create: {
        key: "postprocessing-routes-test-inactive",
        displayName: "Inactive Skill",
        promptRef: "does-not-exist.md",
        isActive: false,
      },
    });

    const user = await prisma.user.create({
      data: { name: "Post-processing Route Test User", email: `pp-route-test-${randomUUID()}@example.com`, role: "reviewer" },
    });
    userId = user.id;

    server = createApp().listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await prisma.postProcessingResult.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.aiOutput.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.stateTransition.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.workflow.deleteMany({ where: { createdById: userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.postProcessingSkillPolicy.delete({ where: { key: "postprocessing-routes-test-inactive" } });
    await prisma.$disconnect();
  });

  it("GET /post-processing-policies returns only active follow-up skills", async () => {
    const response = await fetch(`${baseUrl}/post-processing-policies`);
    expect(response.status).toBe(200);
    const policies = (await response.json()) as Array<{ key: string; displayName: string }>;
    const keys = policies.map((policy) => policy.key);
    expect(keys).toContain("open_questions");
    expect(keys).not.toContain("postprocessing-routes-test-inactive");
  });

  it("GET /workflows/:id/post-processing-results returns every result with a resolved Dutch displayName", async () => {
    const workflow = await engine.createWorkflow({ title: "Post-processing Results Route Test", createdById: userId });

    const aiOutput = await prisma.aiOutput.create({
      data: {
        workflowId: workflow.id,
        skillName: "OpenQuestionsAnalyzer",
        promptVersion: "llm-1",
        schemaVersion: "1.0.0",
        rawOutput: { skill: "OpenQuestionsAnalyzer" },
        validationStatus: ValidationStatus.VALID,
        confidenceScore: 1,
        policyApplied: PolicyType.AUTO,
      },
    });
    await prisma.postProcessingResult.create({
      data: {
        workflowId: workflow.id,
        skillKey: "open_questions",
        status: PostProcessingResultStatus.COMPLETED,
        aiOutputId: aiOutput.id,
        resultJson: { open_questions: [{ question: "Is X afgerond?", explanation: "Nog niet bevestigd." }] },
      },
    });
    await prisma.postProcessingResult.create({
      data: {
        workflowId: workflow.id,
        skillKey: "postprocessing-routes-test-unknown-skill",
        status: PostProcessingResultStatus.SKIPPED,
        errorMessage: 'Geen "normenkader" context aangeleverd voor deze workflow.',
      },
    });

    const response = await fetch(`${baseUrl}/workflows/${workflow.id}/post-processing-results`);
    expect(response.status).toBe(200);
    const results = (await response.json()) as Array<{ skillKey: string; displayName: string; status: string }>;
    expect(results).toHaveLength(2);

    const openQuestions = results.find((r) => r.skillKey === "open_questions");
    expect(openQuestions?.displayName).toBe("Openstaande vragen");
    expect(openQuestions?.status).toBe("COMPLETED");

    const unknown = results.find((r) => r.skillKey === "postprocessing-routes-test-unknown-skill");
    // No catalog row at all for this key -- falls back to the raw key, per
    // the route's own comment.
    expect(unknown?.displayName).toBe("postprocessing-routes-test-unknown-skill");
    expect(unknown?.status).toBe("SKIPPED");
  });

  it("returns 404 for a nonexistent workflow", async () => {
    const response = await fetch(`${baseUrl}/workflows/${randomUUID()}/post-processing-results`);
    expect(response.status).toBe(404);
  });
});
