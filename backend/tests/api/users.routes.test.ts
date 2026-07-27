import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app";
import { prisma } from "../../src/persistence/prismaClient";

// Requires a real Postgres database -- see docs/phase-1/README.md. Exercises
// the actual HTTP route for Phase 10's find-or-create-by-email user stopgap,
// mirroring reportType.routes.test.ts's real-server pattern.
describe("Phase 10 users API", () => {
  let server: Server;
  let baseUrl: string;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
  });

  it("creates a new user", async () => {
    const email = `users-route-test-${randomUUID()}@example.com`;

    const response = await fetch(`${baseUrl}/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test User", email }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; name: string; email: string; role: string };
    expect(body.name).toBe("Test User");
    expect(body.email).toBe(email);
    expect(body.role).toBe("member");
    createdUserIds.push(body.id);
  });

  it("a second call with the same email returns the same user, not a duplicate", async () => {
    const email = `users-route-test-${randomUUID()}@example.com`;

    const first = await fetch(`${baseUrl}/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "First Name", email }),
    });
    const firstBody = (await first.json()) as { id: string };
    createdUserIds.push(firstBody.id);

    const second = await fetch(`${baseUrl}/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Second Name (ignored)", email }),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { id: string; name: string };
    expect(secondBody.id).toBe(firstBody.id);
    // Existing user's name/role are left untouched on a repeat find.
    expect(secondBody.name).toBe("First Name");

    const count = await prisma.user.count({ where: { email } });
    expect(count).toBe(1);
  });

  it("rejects an invalid email", async () => {
    const response = await fetch(`${baseUrl}/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test User", email: "not-an-email" }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects an empty name", async () => {
    const response = await fetch(`${baseUrl}/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "", email: `users-route-test-${randomUUID()}@example.com` }),
    });
    expect(response.status).toBe(400);
  });

  // Phase 16 item 7: lets the frontend confirm a localStorage-remembered user
  // still exists before trusting it for a new action.
  it("GET /users/:id returns the user when it exists", async () => {
    const email = `users-route-test-${randomUUID()}@example.com`;
    const created = await fetch(`${baseUrl}/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Get By Id", email }),
    });
    const { id } = (await created.json()) as { id: string };
    createdUserIds.push(id);

    const response = await fetch(`${baseUrl}/users/${id}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string };
    expect(body.id).toBe(id);
  });

  it("GET /users/:id returns 404 for a user that doesn't exist", async () => {
    const response = await fetch(`${baseUrl}/users/${randomUUID()}`);
    expect(response.status).toBe(404);
  });

  // Phase 16 item 7: a deleted/nonexistent user's id hitting a foreign key
  // (e.g. via POST /workflows) must come back as a clear USER_SESSION_INVALID
  // error, not a raw "Internal server error" -- see api/errorHandler.ts's
  // Prisma P2003 handling.
  it("POST /workflows with a createdById that doesn't exist returns USER_SESSION_INVALID, not a raw 500", async () => {
    const response = await fetch(`${baseUrl}/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Orphaned session test", createdById: randomUUID() }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("USER_SESSION_INVALID");
    expect(body.message).toBe("De gebruiker bestaat niet meer. Maak opnieuw een sessie aan.");
  });
});
