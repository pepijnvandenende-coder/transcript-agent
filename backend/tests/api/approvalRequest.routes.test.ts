import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ActorType, PolicyType } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TranscriptQualityEnvelope } from "../../src/ai/skillEnvelope";
import { createApp } from "../../src/api/app";
import { handleSkillOutput } from "../../src/approval/gateway";
import { prisma } from "../../src/persistence/prismaClient";
import * as engine from "../../src/workflow/engine";
import { WorkflowState } from "../../src/workflow/states";

// Requires a real Postgres database -- see docs/phase-1/README.md. Exercises
// the actual HTTP routes for Phase 3's retry/edit-retry endpoints, mirroring
// uploads.routes.test.ts's real-server pattern.
const SKILL_NAME = "TranscriptQualityChecker";

function envelope(confidence: number): TranscriptQualityEnvelope {
  return {
    skill: SKILL_NAME,
    schema_version: "1.0.0",
    confidence,
    rationale: "test envelope",
    flags: [],
    result: { sufficient: true, issues: [], metrics: {} },
  };
}

describe("POST /workflows/:id/approval-request/retry and /edit-retry", () => {
  let userId: string;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    await prisma.approvalPolicy.upsert({
      where: { skillName: SKILL_NAME },
      update: { policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.75, maxRetries: 5 },
      create: { skillName: SKILL_NAME, policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.75 },
    });

    const user = await prisma.user.create({
      data: { name: "Approval Route Test User", email: `approval-route-test-${randomUUID()}@example.com`, role: "reviewer" },
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
    await prisma.aiOutput.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.transcript.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.workflow.deleteMany({ where: { createdById: userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  async function workflowAtCheckpoint(title: string) {
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
      envelope: envelope(0.5), // below the 0.75 threshold -> PENDING_HUMAN_CONFIRMATION
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });
    return workflow.id;
  }

  it("retries from the checkpoint and returns the workflow back at VALIDATING_TRANSCRIPT", async () => {
    const workflowId = await workflowAtCheckpoint("Approval Route Retry");

    const response = await fetch(`${baseUrl}/workflows/${workflowId}/approval-request/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: userId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { currentState: string };
    expect(body.currentState).toBe(WorkflowState.VALIDATING_TRANSCRIPT);
  });

  it("edit-retries with a new transcript and returns the workflow back at VALIDATING_TRANSCRIPT", async () => {
    const workflowId = await workflowAtCheckpoint("Approval Route Edit Retry");

    const response = await fetch(`${baseUrl}/workflows/${workflowId}/approval-request/edit-retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: userId, transcriptContent: "an edited transcript" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { currentState: string };
    expect(body.currentState).toBe(WorkflowState.VALIDATING_TRANSCRIPT);

    const transcripts = await prisma.transcript.findMany({ where: { workflowId } });
    expect(transcripts).toHaveLength(1);
  });

  it("rejects edit-retry with neither transcriptContent nor notesContent", async () => {
    const workflowId = await workflowAtCheckpoint("Approval Route Edit Retry Empty Body");

    const response = await fetch(`${baseUrl}/workflows/${workflowId}/approval-request/edit-retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: userId }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects retry when the workflow is not at PENDING_HUMAN_CONFIRMATION", async () => {
    const workflow = await engine.createWorkflow({ title: "Approval Route Not At Checkpoint", createdById: userId });

    const response = await fetch(`${baseUrl}/workflows/${workflow.id}/approval-request/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: userId }),
    });
    expect(response.status).toBe(409);
  });
});
