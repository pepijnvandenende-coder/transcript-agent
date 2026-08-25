import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app";
import { prisma } from "../../src/persistence/prismaClient";
import * as engine from "../../src/workflow/engine";

// Requires a real Postgres database -- see docs/phase-1/README.md. Exercises
// the Phase 18 explicit context step's HTTP routes: POST/GET
// /workflows/:id/context and GET /context-type-policies. Notes (uploads.routes.test.ts)
// are deliberately untouched by this change -- see prisma/schema.prisma's
// ContextItem comment for why context types are a separate mechanism.
describe("context routes (Phase 18)", () => {
  let userId: string;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    // Self-seeded (idempotent upsert), same convention as every other test
    // file's catalog rows -- never relies on prisma/seed.ts having been run.
    await prisma.contextTypePolicy.upsert({
      where: { key: "pva" },
      update: { isActive: true },
      create: {
        key: "pva",
        displayName: "Plan van Aanpak (PvA)",
        description: "Het plan van aanpak.",
        instructionLabel: "Plan van Aanpak (PvA)",
        sortOrder: 1,
      },
    });
    await prisma.contextTypePolicy.upsert({
      where: { key: "normenkader" },
      update: { isActive: true },
      create: {
        key: "normenkader",
        displayName: "Normenkader",
        description: "Het normenkader.",
        instructionLabel: "Normenkader",
        sortOrder: 2,
      },
    });
    await prisma.contextTypePolicy.upsert({
      where: { key: "context-routes-test-inactive" },
      update: { isActive: false },
      create: {
        key: "context-routes-test-inactive",
        displayName: "Inactive Type",
        instructionLabel: "Inactive Type",
        isActive: false,
      },
    });

    const user = await prisma.user.create({
      data: { name: "Context Route Test User", email: `context-route-test-${randomUUID()}@example.com`, role: "reviewer" },
    });
    userId = user.id;

    server = createApp().listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await prisma.contextItem.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.stateTransition.deleteMany({
      where: { OR: [{ actorId: userId }, { workflow: { createdById: userId } }] },
    });
    await prisma.transcript.deleteMany({ where: { workflow: { createdById: userId } } });
    await prisma.workflow.deleteMany({ where: { createdById: userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.contextTypePolicy.delete({ where: { key: "context-routes-test-inactive" } });
    await prisma.$disconnect();
  });

  it("GET /context-type-policies returns only active types", async () => {
    const response = await fetch(`${baseUrl}/context-type-policies`);
    expect(response.status).toBe(200);
    const policies = (await response.json()) as Array<{ key: string; displayName: string }>;
    const keys = policies.map((policy) => policy.key);
    expect(keys).toEqual(expect.arrayContaining(["pva", "normenkader"]));
    expect(keys).not.toContain("context-routes-test-inactive");
  });

  it("POST /workflows/:id/context stores a context item without requiring or changing the FSM state (context is optional/non-blocking)", async () => {
    const workflow = await engine.createWorkflow({ title: "Context Route Test", createdById: userId });

    const response = await fetch(`${baseUrl}/workflows/${workflow.id}/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadedById: userId, contextType: "pva", content: "Inhoud van het plan van aanpak." }),
    });
    expect(response.status).toBe(201);
    const item = (await response.json()) as { workflowId: string; contextType: string; version: number };
    expect(item.workflowId).toBe(workflow.id);
    expect(item.contextType).toBe("pva");
    expect(item.version).toBe(1);

    // No transition was triggered -- the workflow is still exactly where it
    // started (Phase 19: CONTEXT_INPUT, the step this upload happens on),
    // same as uploading notes today.
    const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
    expect(reloaded.currentState).toBe("CONTEXT_INPUT");
  });

  it("supports multiple independent context types for the same workflow, each versioned on its own", async () => {
    const workflow = await engine.createWorkflow({ title: "Context Route Multi-Type Test", createdById: userId });

    await fetch(`${baseUrl}/workflows/${workflow.id}/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadedById: userId, contextType: "pva", content: "PvA inhoud" }),
    });
    await fetch(`${baseUrl}/workflows/${workflow.id}/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadedById: userId, contextType: "normenkader", content: "Normenkader inhoud" }),
    });
    // Re-submitting "pva" creates a new version, without touching "normenkader"'s.
    const secondPva = await fetch(`${baseUrl}/workflows/${workflow.id}/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadedById: userId, contextType: "pva", content: "PvA inhoud, aangepast" }),
    });
    expect(((await secondPva.json()) as { version: number }).version).toBe(2);

    const getResponse = await fetch(`${baseUrl}/workflows/${workflow.id}/context`);
    expect(getResponse.status).toBe(200);
    const items = (await getResponse.json()) as Array<{ contextType: string; version: number }>;
    expect(items).toHaveLength(2);
    const pva = items.find((item) => item.contextType === "pva");
    const normenkader = items.find((item) => item.contextType === "normenkader");
    expect(pva?.version).toBe(2);
    expect(normenkader?.version).toBe(1);
  });

  it("rejects an unknown or inactive context type with 400", async () => {
    const workflow = await engine.createWorkflow({ title: "Context Route Invalid Type Test", createdById: userId });

    const unknown = await fetch(`${baseUrl}/workflows/${workflow.id}/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadedById: userId, contextType: "does_not_exist", content: "x" }),
    });
    expect(unknown.status).toBe(400);

    const inactive = await fetch(`${baseUrl}/workflows/${workflow.id}/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadedById: userId, contextType: "context-routes-test-inactive", content: "x" }),
    });
    expect(inactive.status).toBe(400);
  });

  it("returns 404 for a nonexistent workflow", async () => {
    const response = await fetch(`${baseUrl}/workflows/${randomUUID()}/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadedById: userId, contextType: "pva", content: "x" }),
    });
    expect(response.status).toBe(404);
  });

  describe("Phase 19: continue-to-transcript / back-to-context actions", () => {
    it("POST /actions/continue-to-transcript moves a fresh workflow from CONTEXT_INPUT to CREATED, with no context required", async () => {
      const workflow = await engine.createWorkflow({ title: "Continue Without Context", createdById: userId });
      expect(workflow.currentState).toBe("CONTEXT_INPUT");

      const response = await fetch(`${baseUrl}/workflows/${workflow.id}/actions/continue-to-transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actorId: userId }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { currentState: string };
      expect(body.currentState).toBe("CREATED");
    });

    it("POST /actions/continue-to-transcript still works after one or more context types were submitted", async () => {
      const workflow = await engine.createWorkflow({ title: "Continue With Context", createdById: userId });
      await fetch(`${baseUrl}/workflows/${workflow.id}/context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadedById: userId, contextType: "pva", content: "PvA inhoud" }),
      });

      const response = await fetch(`${baseUrl}/workflows/${workflow.id}/actions/continue-to-transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actorId: userId }),
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { currentState: string }).currentState).toBe("CREATED");
    });

    it("POST /actions/continue-to-transcript is rejected once the workflow has already left CREATED (409)", async () => {
      const workflow = await engine.createWorkflow({ title: "Continue Twice", createdById: userId });
      await fetch(`${baseUrl}/workflows/${workflow.id}/actions/continue-to-transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actorId: userId }),
      });

      const second = await fetch(`${baseUrl}/workflows/${workflow.id}/actions/continue-to-transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actorId: userId }),
      });
      expect(second.status).toBe(409);
    });

    it("upload_transcript is rejected while still at CONTEXT_INPUT (context step cannot be bypassed)", async () => {
      const workflow = await engine.createWorkflow({ title: "Bypass Attempt", createdById: userId });

      const response = await fetch(`${baseUrl}/workflows/${workflow.id}/transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadedById: userId, content: "sneaky transcript" }),
      });
      expect(response.status).toBe(409);
    });

    it("POST /actions/back-to-context moves CREATED back to CONTEXT_INPUT, and a second continue-to-transcript still works", async () => {
      const workflow = await engine.createWorkflow({ title: "Back To Context", createdById: userId });
      await fetch(`${baseUrl}/workflows/${workflow.id}/actions/continue-to-transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actorId: userId }),
      });

      const back = await fetch(`${baseUrl}/workflows/${workflow.id}/actions/back-to-context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actorId: userId }),
      });
      expect(back.status).toBe(200);
      expect(((await back.json()) as { currentState: string }).currentState).toBe("CONTEXT_INPUT");

      const forward = await fetch(`${baseUrl}/workflows/${workflow.id}/actions/continue-to-transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actorId: userId }),
      });
      expect(forward.status).toBe(200);
      expect(((await forward.json()) as { currentState: string }).currentState).toBe("CREATED");
    });

    it("context submitted before navigating back is still there after continue-to-transcript again (no data loss on back navigation)", async () => {
      const workflow = await engine.createWorkflow({ title: "No Data Loss On Back", createdById: userId });
      await fetch(`${baseUrl}/workflows/${workflow.id}/context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadedById: userId, contextType: "normenkader", content: "Norm 1." }),
      });
      await fetch(`${baseUrl}/workflows/${workflow.id}/actions/continue-to-transcript`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actorId: userId }),
      });
      await fetch(`${baseUrl}/workflows/${workflow.id}/actions/back-to-context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actorId: userId }),
      });

      const getResponse = await fetch(`${baseUrl}/workflows/${workflow.id}/context`);
      const items = (await getResponse.json()) as Array<{ contextType: string; version: number }>;
      expect(items.find((item) => item.contextType === "normenkader")?.version).toBe(1);
    });

    it("back-to-context is rejected from CONTEXT_INPUT itself (409)", async () => {
      const workflow = await engine.createWorkflow({ title: "Back Too Early", createdById: userId });

      const response = await fetch(`${baseUrl}/workflows/${workflow.id}/actions/back-to-context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actorId: userId }),
      });
      expect(response.status).toBe(409);
    });
  });
});
