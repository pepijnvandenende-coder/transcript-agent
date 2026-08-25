import { prisma } from "../prismaClient";

// The additional-context type catalog (Phase 18) -- metadata only, same
// shape/role as reportTypePolicyRepository.ts's findActivePolicies(). Which
// context types the frontend's context step offers (and which
// draftGenerationRunner.ts folds into the DraftGenerator prompt) is entirely
// driven by this table's isActive rows -- no code change needed to add or
// retire a type.
export function findActiveContextTypePolicies() {
  return prisma.contextTypePolicy.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } });
}

export function findContextTypePolicyByKey(key: string) {
  return prisma.contextTypePolicy.findUnique({ where: { key } });
}
