import { randomUUID } from "node:crypto";
import { ActorType } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InvalidTransitionError } from "../../src/domain/types";
import { prisma } from "../../src/persistence/prismaClient";
import * as engine from "../../src/workflow/engine";
import { WorkflowState } from "../../src/workflow/states";

// These tests exercise engine.ts against a real Postgres database (the
// migrations must already be applied -- see docs/phase-1/README.md).
// transitions.test.ts covers the FSM table's pure logic without any DB
// dependency; these tests are the ones that actually need DATABASE_URL.
describe("workflow engine", () => {
  let userId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        name: "Engine Test User",
        email: `engine-test-${randomUUID()}@example.com`,
        role: "reviewer",
      },
    });
    userId = user.id;
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

  it("creates a workflow at CONTEXT_INPUT and writes the initial audit row", async () => {
    const workflow = await engine.createWorkflow({ title: "Q1 Audit", createdById: userId });
    expect(workflow.currentState).toBe(WorkflowState.CONTEXT_INPUT);

    const history = await prisma.stateTransition.findMany({ where: { workflowId: workflow.id } });
    expect(history).toHaveLength(1);
    expect(history[0].fromState).toBeNull();
    expect(history[0].toState).toBe(WorkflowState.CONTEXT_INPUT);
  });

  // Phase 19: CONTEXT_INPUT -> CREATED (continue_to_transcript) is now a
  // mandatory hop before upload_transcript is even reachable -- see
  // workflow/transitions.ts.
  it("continue_to_transcript moves CONTEXT_INPUT to CREATED, valid with or without any context submitted", async () => {
    const workflow = await engine.createWorkflow({ title: "Q1 Audit", createdById: userId });

    const updated = await engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "continue_to_transcript" },
      actor: { actorType: ActorType.USER, actorId: userId },
    });

    expect(updated.currentState).toBe(WorkflowState.CREATED);
  });

  it("back_to_context moves CREATED back to CONTEXT_INPUT", async () => {
    const workflow = await engine.createWorkflow({ title: "Q1 Audit", createdById: userId });
    await engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "continue_to_transcript" },
      actor: { actorType: ActorType.USER, actorId: userId },
    });

    const updated = await engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "back_to_context" },
      actor: { actorType: ActorType.USER, actorId: userId },
    });

    expect(updated.currentState).toBe(WorkflowState.CONTEXT_INPUT);
  });

  it("rejects upload_transcript before the context step has been passed through", async () => {
    const workflow = await engine.createWorkflow({ title: "Q1 Audit", createdById: userId });

    await expect(
      engine.transition({
        workflowId: workflow.id,
        trigger: { kind: "user_action", action: "upload_transcript" },
        actor: { actorType: ActorType.USER, actorId: userId },
      }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("applies a valid transition and appends to the audit trail", async () => {
    const workflow = await engine.createWorkflow({ title: "Q1 Audit", createdById: userId });
    await engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "continue_to_transcript" },
      actor: { actorType: ActorType.USER, actorId: userId },
    });

    const updated = await engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "upload_transcript" },
      actor: { actorType: ActorType.USER, actorId: userId },
    });

    expect(updated.currentState).toBe(WorkflowState.TRANSCRIPT_UPLOADED);

    const history = await prisma.stateTransition.findMany({
      where: { workflowId: workflow.id },
      orderBy: { occurredAt: "asc" },
    });
    expect(history).toHaveLength(3);
    expect(history[2].fromState).toBe(WorkflowState.CREATED);
    expect(history[2].toState).toBe(WorkflowState.TRANSCRIPT_UPLOADED);
    expect(history[2].actorId).toBe(userId);
  });

  it("rejects an invalid transition and leaves state and history unchanged", async () => {
    const workflow = await engine.createWorkflow({ title: "Q1 Audit", createdById: userId });

    await expect(
      engine.transition({
        workflowId: workflow.id,
        trigger: { kind: "user_action", action: "approve_draft" },
        actor: { actorType: ActorType.USER, actorId: userId },
      }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);

    const reloaded = await prisma.workflow.findUniqueOrThrow({ where: { id: workflow.id } });
    expect(reloaded.currentState).toBe(WorkflowState.CONTEXT_INPUT);

    const history = await prisma.stateTransition.findMany({ where: { workflowId: workflow.id } });
    expect(history).toHaveLength(1); // only the creation row -- the rejected attempt wrote nothing
  });

  it("keeps currentState consistent with the latest audit row after cancel, and sets status", async () => {
    const workflow = await engine.createWorkflow({ title: "Q1 Audit", createdById: userId });

    const cancelled = await engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "cancel" },
      actor: { actorType: ActorType.USER, actorId: userId },
    });

    expect(cancelled.currentState).toBe(WorkflowState.CANCELLED);
    expect(cancelled.status).toBe("CANCELLED");

    const history = await prisma.stateTransition.findMany({
      where: { workflowId: workflow.id },
      orderBy: { occurredAt: "asc" },
    });
    expect(history.at(-1)?.toState).toBe(WorkflowState.CANCELLED);
  });

  it("refuses to transition a workflow that is no longer active", async () => {
    const workflow = await engine.createWorkflow({ title: "Q1 Audit", createdById: userId });

    await engine.transition({
      workflowId: workflow.id,
      trigger: { kind: "user_action", action: "cancel" },
      actor: { actorType: ActorType.USER, actorId: userId },
    });

    await expect(
      engine.transition({
        workflowId: workflow.id,
        trigger: { kind: "user_action", action: "upload_transcript" },
        actor: { actorType: ActorType.USER, actorId: userId },
      }),
    ).rejects.toThrow(/is not active/);
  });
});
