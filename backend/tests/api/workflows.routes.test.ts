import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PolicyType } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app";
import { processNextJob } from "../../src/jobs/worker";
import { prisma } from "../../src/persistence/prismaClient";

// Requires a real Postgres database -- see docs/phase-1/README.md. Covers
// two Phase 13 additions: GET /workflows/:id/jobs/latest (status info for
// "why is this workflow waiting") and POST
// /workflows/:id/actions/retry-failed-job (the recovery path for
// jobs/worker.ts's failJob() fix -- until this phase, a failed job left the
// workflow stuck at its PROCESSING state forever, with no route to recover).
const SKILL_NAME = "TranscriptQualityChecker";

describe("GET /workflows/:id/jobs/latest and POST /workflows/:id/actions/retry-failed-job", () => {
  let userId: string;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    await prisma.approvalPolicy.upsert({
      where: { skillName: SKILL_NAME },
      update: { policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.75 },
      create: { skillName: SKILL_NAME, policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.75 },
    });

    const user = await prisma.user.create({
      data: { name: "Workflows Route Test User", email: `workflows-route-test-${randomUUID()}@example.com`, role: "reviewer" },
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
    await prisma.job.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.aiOutput.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.transcript.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.workflow.deleteMany({ where: { createdById: userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  async function createWorkflow(title: string) {
    const response = await fetch(`${baseUrl}/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, createdById: userId }),
    });
    return (await response.json()) as { id: string };
  }

  async function uploadAndSubmit(workflowId: string) {
    await fetch(`${baseUrl}/workflows/${workflowId}/transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadedById: userId, content: "a transcript with plenty of words" }),
    });
    await fetch(`${baseUrl}/workflows/${workflowId}/actions/validate-transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: userId }),
    });
  }

  // claimNextQueuedJob() claims the globally oldest QUEUED job across every
  // workflow -- other tests in this same file (and this suite's own earlier
  // assertions) can leave unrelated QUEUED jobs behind. Poll until this
  // specific job id leaves QUEUED, same pattern as tests/jobs/worker.test.ts's
  // processUntilSettled(), rather than assuming one processNextJob() call
  // claims this exact job.
  async function processUntilJobSettled(jobId: string, maxAttempts = 50): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
      if (job.status !== "QUEUED") return;
      const didWork = await processNextJob();
      if (!didWork) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }

  it("returns 404 for jobs/latest when the workflow has no job yet", async () => {
    const workflow = await createWorkflow("Jobs Latest - No Job");

    const response = await fetch(`${baseUrl}/workflows/${workflow.id}/jobs/latest`);
    expect(response.status).toBe(404);
  });

  it("returns the workflow's most recent job", async () => {
    const workflow = await createWorkflow("Jobs Latest - Queued Job");
    await uploadAndSubmit(workflow.id);

    const response = await fetch(`${baseUrl}/workflows/${workflow.id}/jobs/latest`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { jobType: string; status: string };
    expect(body.jobType).toBe("VALIDATE_TRANSCRIPT");
    expect(body.status).toBe("QUEUED");
  });

  it("rejects retry-failed-job when the workflow is not at FAILED", async () => {
    const workflow = await createWorkflow("Retry Failed Job - Wrong State");
    await uploadAndSubmit(workflow.id);

    const response = await fetch(`${baseUrl}/workflows/${workflow.id}/actions/retry-failed-job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: userId }),
    });
    expect(response.status).toBe(409);
  });

  it("a runner failure moves the workflow to FAILED with the error visible, and retry-failed-job recovers it", async () => {
    const workflow = await createWorkflow("Retry Failed Job - Real Failure");
    await uploadAndSubmit(workflow.id);
    const queuedJob = await prisma.job.findFirstOrThrow({
      where: { workflowId: workflow.id },
      orderBy: { createdAt: "desc" },
    });

    // Force the queued VALIDATE_TRANSCRIPT job to fail deterministically:
    // policyResolver.resolvePolicy() throws when no approval_policies row
    // exists for the skill.
    await prisma.approvalPolicy.delete({ where: { skillName: SKILL_NAME } });
    try {
      await processUntilJobSettled(queuedJob.id);

      const afterFailure = await fetch(`${baseUrl}/workflows/${workflow.id}`);
      const workflowAfterFailure = (await afterFailure.json()) as { currentState: string };
      expect(workflowAfterFailure.currentState).toBe("FAILED");

      const latestJob = await fetch(`${baseUrl}/workflows/${workflow.id}/jobs/latest`);
      const jobBody = (await latestJob.json()) as { status: string; error: string | null };
      expect(jobBody.status).toBe("FAILED");
      expect(jobBody.error).toContain("No approval_policies row configured");
    } finally {
      await prisma.approvalPolicy.create({
        data: { skillName: SKILL_NAME, policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.75 },
      });
    }

    const retryResponse = await fetch(`${baseUrl}/workflows/${workflow.id}/actions/retry-failed-job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: userId }),
    });
    expect(retryResponse.status).toBe(200);
    const retried = (await retryResponse.json()) as { currentState: string };
    expect(retried.currentState).toBe("VALIDATING_TRANSCRIPT");

    // retry-failed-job re-enqueues a fresh job for the originating state (see
    // workflows.routes.ts's use of enqueueForStateEntry, no retry lineage --
    // unlike PENDING_HUMAN_CONFIRMATION's retry, this job never produced an
    // ai_output to link back to) -- find it as the newest job that isn't the
    // one that just failed. Now that the policy row is restored, it succeeds.
    const retryJob = await prisma.job.findFirstOrThrow({
      where: { workflowId: workflow.id, id: { not: queuedJob.id } },
      orderBy: { createdAt: "desc" },
    });
    await processUntilJobSettled(retryJob.id);
    const afterRecovery = await fetch(`${baseUrl}/workflows/${workflow.id}`);
    const workflowAfterRecovery = (await afterRecovery.json()) as { currentState: string };
    expect(workflowAfterRecovery.currentState).toBe("MERGING");
  });
});
