import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ActorType, PolicyType } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConflictDetectorEnvelope, MergerEnvelope, TranscriptQualityEnvelope } from "../../src/ai/skillEnvelope";
import { createApp } from "../../src/api/app";
import { handleSkillOutput } from "../../src/approval/gateway";
import { createConflicts } from "../../src/persistence/repositories/conflictRepository";
import { prisma } from "../../src/persistence/prismaClient";
import * as engine from "../../src/workflow/engine";
import { WorkflowState } from "../../src/workflow/states";

// Requires a real Postgres database -- see docs/phase-1/README.md. Exercises
// the actual HTTP routes for Phase 4's conflicts endpoints, mirroring
// approvalRequest.routes.test.ts's real-server pattern.
const SKILL_NAME = "TranscriptQualityChecker";
const MERGER_SKILL_NAME = "Merger";
const CONFLICT_DETECTOR_SKILL_NAME = "ConflictDetector";

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
      notes_provided: true,
    },
  };
}

function conflictDetectorEnvelope(conflictDescriptions: string[]): ConflictDetectorEnvelope {
  return {
    skill: CONFLICT_DETECTOR_SKILL_NAME,
    schema_version: "1.0.0",
    confidence: 0.9,
    rationale: "test envelope",
    flags: [],
    result: { conflicts: conflictDescriptions.map((description) => ({ description })) },
  };
}

describe("Phase 4 conflicts API", () => {
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

    const user = await prisma.user.create({
      data: { name: "Conflicts Route Test User", email: `conflicts-route-test-${randomUUID()}@example.com`, role: "reviewer" },
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
    await prisma.conflict.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.merge.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.aiOutput.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.transcript.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.workflow.deleteMany({ where: { createdById: userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  async function workflowAtConflictsPendingReview(title: string, conflictDescriptions: string[]) {
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
    const { aiOutputId } = await handleSkillOutput({
      workflowId: workflow.id,
      envelope: conflictDetectorEnvelope(conflictDescriptions),
      promptVersion: "stub-1",
      schemaVersion: "1.0.0",
    });
    // handleSkillOutput() never writes skill-specific rows itself (mirrors
    // Merger/`merges` -- see mergeRunner.ts) -- conflictDetectionRunner.ts
    // does this in the real flow; this test calls handleSkillOutput()
    // directly (bypassing the job queue), so it's done here instead.
    await createConflicts({
      workflowId: workflow.id,
      aiOutputId,
      conflicts: conflictDescriptions.map((description) => ({ description })),
    });
    return workflow.id;
  }

  it("GET /workflows/:id/conflicts lists the conflicts for a workflow", async () => {
    const workflowId = await workflowAtConflictsPendingReview("Conflicts Route List", ["first", "second"]);

    const response = await fetch(`${baseUrl}/workflows/${workflowId}/conflicts`);
    expect(response.status).toBe(200);
    const conflicts = (await response.json()) as Array<{ id: string; status: string; description: string }>;
    expect(conflicts).toHaveLength(2);
    expect(conflicts.every((c) => c.status === "OPEN")).toBe(true);
  });

  it("GET /workflows/:id/conflicts 404s for a nonexistent workflow", async () => {
    const response = await fetch(`${baseUrl}/workflows/${randomUUID()}/conflicts`);
    expect(response.status).toBe(404);
  });

  it("POST .../conflicts/:conflictId/explain only advances the workflow once every conflict is resolved", async () => {
    const workflowId = await workflowAtConflictsPendingReview("Conflicts Route Explain", ["first", "second"]);
    const listResponse = await fetch(`${baseUrl}/workflows/${workflowId}/conflicts`);
    const conflicts = (await listResponse.json()) as Array<{ id: string }>;

    const firstResponse = await fetch(`${baseUrl}/workflows/${workflowId}/conflicts/${conflicts[0].id}/explain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: userId, explanation: "resolved first" }),
    });
    expect(firstResponse.status).toBe(200);
    const firstBody = (await firstResponse.json()) as { workflow: unknown };
    expect(firstBody.workflow).toBeNull();

    let reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId } });
    expect(reloaded.currentState).toBe(WorkflowState.CONFLICTS_PENDING_REVIEW);

    const secondResponse = await fetch(`${baseUrl}/workflows/${workflowId}/conflicts/${conflicts[1].id}/explain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: userId, explanation: "resolved second" }),
    });
    expect(secondResponse.status).toBe(200);
    const secondBody = (await secondResponse.json()) as { workflow: { currentState: string } };
    expect(secondBody.workflow.currentState).toBe(WorkflowState.MERGING);

    reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflowId } });
    expect(reloaded.currentState).toBe(WorkflowState.MERGING);
  });

  it("POST .../actions/restart-upload rewinds to TRANSCRIPT_UPLOADED", async () => {
    const workflowId = await workflowAtConflictsPendingReview("Conflicts Route Restart", ["only conflict"]);

    const response = await fetch(`${baseUrl}/workflows/${workflowId}/actions/restart-upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: userId }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { currentState: string };
    expect(body.currentState).toBe(WorkflowState.TRANSCRIPT_UPLOADED);
  });

  it("rejects explain and restart-upload when the workflow is not at CONFLICTS_PENDING_REVIEW", async () => {
    const workflow = await engine.createWorkflow({ title: "Conflicts Route Not At Review", createdById: userId });

    const restartResponse = await fetch(`${baseUrl}/workflows/${workflow.id}/actions/restart-upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: userId }),
    });
    expect(restartResponse.status).toBe(409);

    const explainResponse = await fetch(`${baseUrl}/workflows/${workflow.id}/conflicts/${randomUUID()}/explain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorId: userId, explanation: "x" }),
    });
    expect(explainResponse.status).toBe(409);
  });
});
