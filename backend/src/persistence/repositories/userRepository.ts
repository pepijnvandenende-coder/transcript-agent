import { prisma } from "../prismaClient";

// Phase 10: a find-or-create-by-email stopgap for user identity, standing in
// for real authentication (a later phase will replace this, not extend it --
// see api/users.routes.ts's doc comment). role is hardcoded "member" on
// creation since no role-based access exists anywhere yet; an existing
// user's role is left untouched. Email matching is exact-string, not
// case-normalized -- a known, flagged limitation of the stopgap.
export async function findOrCreateUserByEmail(params: { name: string; email: string }) {
  const existing = await prisma.user.findUnique({ where: { email: params.email } });
  if (existing) return existing;

  return prisma.user.create({
    data: {
      name: params.name,
      email: params.email,
      role: "member",
    },
  });
}

// Phase 16 item 7: lets the frontend confirm a localStorage-remembered user
// still exists before trusting it (e.g. after test data was cleaned up
// server-side) -- see api/users.routes.ts's GET /:id.
export function findUserById(id: string) {
  return prisma.user.findUnique({ where: { id } });
}
