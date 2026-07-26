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
});
