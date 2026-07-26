import { PrismaClient } from "@prisma/client";

// A single shared PrismaClient instance for the whole process. Creating one
// per request would exhaust Postgres connections -- this is Prisma's own
// recommended pattern for a long-running Node server.
export const prisma = new PrismaClient();
