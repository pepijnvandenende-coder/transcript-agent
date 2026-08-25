import { prisma } from "../prismaClient";

// The post-processing follow-up skill catalog (Phase 18) -- same shape/role
// as reportTypePolicyRepository.ts/contextTypePolicyRepository.ts. Which
// follow-up skills postProcessingRunner.ts actually runs, and in what order,
// is entirely driven by this table's isActive rows and sortOrder.
export function findActivePostProcessingSkillPolicies() {
  return prisma.postProcessingSkillPolicy.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } });
}

// Includes inactive rows -- used to resolve a Dutch displayName for a
// post_processing_results row even if its skill was later deactivated, so
// past results stay human-readable.
export function findAllPostProcessingSkillPolicies() {
  return prisma.postProcessingSkillPolicy.findMany({ orderBy: { sortOrder: "asc" } });
}
