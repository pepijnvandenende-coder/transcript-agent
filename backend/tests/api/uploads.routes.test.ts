import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ActorType } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app";
import { prisma } from "../../src/persistence/prismaClient";
import * as engine from "../../src/workflow/engine";
import { WorkflowState } from "../../src/workflow/states";

// Requires a real Postgres database -- see docs/phase-1/README.md. Exercises
// the actual HTTP route (not just the underlying functions), since the bug
// this guards against was specifically in how the route wired them together:
// createTranscriptVersion() and engine.transition() each worked fine in
// isolation, but the route never called the latter.
describe("POST /workflows/:id/transcript", () => {
  let userId: string;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { name: "Uploads Route Test User", email: `uploads-route-test-${randomUUID()}@example.com`, role: "reviewer" },
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
    await prisma.transcript.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.workflow.deleteMany({ where: { createdById: userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("transitions the workflow from CREATED to TRANSCRIPT_UPLOADED", async () => {
    const workflow = await engine.createWorkflow({ title: "Upload Route Test", createdById: userId });
    expect(workflow.currentState).toBe(WorkflowState.CONTEXT_INPUT);
    // Phase 19: CREATED is only reachable after the mandatory context step.
    await engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "continue_to_transcript" },
      actor: { actorType: ActorType.USER, actorId: userId },
    });

    const response = await fetch(`${baseUrl}/workflows/${workflow.id}/transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadedById: userId, content: "some transcript content" }),
    });
    expect(response.status).toBe(201);
    const transcript = (await response.json()) as { workflowId: string; version: number };
    expect(transcript.workflowId).toBe(workflow.id);
    expect(transcript.version).toBe(1);

    const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
    expect(reloaded.currentState).toBe(WorkflowState.TRANSCRIPT_UPLOADED);

    const history = await prisma.stateTransition.findMany({
      where: { workflowId: workflow.id },
      orderBy: { occurredAt: "asc" },
    });
    expect(history).toHaveLength(3);
    expect(history[2].fromState).toBe(WorkflowState.CREATED);
    expect(history[2].toState).toBe(WorkflowState.TRANSCRIPT_UPLOADED);
    expect(history[2].actorId).toBe(userId);
  });

  it("returns 404 for a nonexistent workflow", async () => {
    const response = await fetch(`${baseUrl}/workflows/${randomUUID()}/transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadedById: userId, content: "x" }),
    });
    expect(response.status).toBe(404);
  });

  it("rejects a second upload once the workflow has already left CREATED", async () => {
    const workflow = await engine.createWorkflow({ title: "Upload Route Test 2", createdById: userId });
    await engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "continue_to_transcript" },
      actor: { actorType: ActorType.USER, actorId: userId },
    });

    const first = await fetch(`${baseUrl}/workflows/${workflow.id}/transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadedById: userId, content: "first upload" }),
    });
    expect(first.status).toBe(201);

    const second = await fetch(`${baseUrl}/workflows/${workflow.id}/transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadedById: userId, content: "second upload" }),
    });
    expect(second.status).toBe(409);
  });
});
