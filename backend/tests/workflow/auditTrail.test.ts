import { randomUUID } from "node:crypto";
import { ActorType } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/persistence/prismaClient";
import * as engine from "../../src/workflow/engine";
import { recordTransition } from "../../src/workflow/auditTrail";
import { WorkflowState } from "../../src/workflow/states";

// Requires a real Postgres database (DATABASE_URL) with migrations applied --
// see docs/phase-1/README.md.
describe("auditTrail.recordTransition", () => {
  let userId: string;
  let workflowId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { name: "Audit Test User", email: `audit-test-${randomUUID()}@example.com`, role: "reviewer" },
    });
    userId = user.id;
    const workflow = await engine.createWorkflow({ title: "Audit Trail Fixture", createdById: userId });
    workflowId = workflow.id;
  });

  afterAll(async () => {
    // Workflows and their state transitions reference this user via
    // createdById/actorId with no cascade delete, so they must be removed
    // before the user row itself can be deleted.
    await prisma.stateTransition.deleteMany({
      where: { OR: [{ actorId: userId }, { workflow: { createdById: userId } }] },
    });
    await prisma.workflow.deleteMany({ where: { createdById: userId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("writes every field passed to it", async () => {
    const entry = await prisma.$transaction((tx) =>
      recordTransition(tx, {
        workflowId,
        fromState: WorkflowState.CREATED,
        toState: WorkflowState.TRANSCRIPT_UPLOADED,
        actorType: ActorType.USER,
        actorId: userId,
        metadata: { note: "manual test entry" },
      }),
    );

    expect(entry.workflowId).toBe(workflowId);
    expect(entry.fromState).toBe(WorkflowState.CREATED);
    expect(entry.toState).toBe(WorkflowState.TRANSCRIPT_UPLOADED);
    expect(entry.actorType).toBe(ActorType.USER);
    expect(entry.actorId).toBe(userId);
    expect(entry.metadata).toEqual({ note: "manual test entry" });
    expect(entry.occurredAt).toBeInstanceOf(Date);
  });

  it("allows a null fromState, used for the initial creation event", async () => {
    const rows = await prisma.stateTransition.findMany({
      where: { workflowId },
      orderBy: { occurredAt: "asc" },
    });
    expect(rows[0].fromState).toBeNull();
    expect(rows[0].toState).toBe(WorkflowState.CREATED);
  });

  it("is append-only: each call adds a row rather than mutating an existing one", async () => {
    const before = await prisma.stateTransition.count({ where: { workflowId } });

    await prisma.$transaction((tx) =>
      recordTransition(tx, {
        workflowId,
        fromState: WorkflowState.TRANSCRIPT_UPLOADED,
        toState: WorkflowState.VALIDATING_TRANSCRIPT,
        actorType: ActorType.USER,
        actorId: userId,
      }),
    );

    const after = await prisma.stateTransition.count({ where: { workflowId } });
    expect(after).toBe(before + 1);
  });
});
