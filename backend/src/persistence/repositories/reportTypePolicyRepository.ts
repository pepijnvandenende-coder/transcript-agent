import { prisma } from "../prismaClient";

// The report generation policy catalog (Phase 6) -- metadata only, used for
// lookup and structural validation. The actual Dutch prompt instructions
// live in files referenced by `promptRef` (see ai/prompts/reportTypeLoader.ts),
// not in this table.
export function findPolicyByKey(key: string) {
  return prisma.reportTypePolicy.findUnique({ where: { key } });
}

// Case-insensitive match against either the English `key` or the Dutch
// `displayName` -- used by the tightened POST /workflows/:id/report-type
// (Phase 6) so a human can submit either form, and by
// ai/skills/reportTypeAdvisor.ts's retrofit, which now suggests the
// catalog's own displayName values.
export async function findPolicyByKeyOrDisplayName(value: string) {
  const policies = await prisma.reportTypePolicy.findMany({ where: { isActive: true } });
  const normalized = value.trim().toLowerCase();
  return (
    policies.find(
      (policy) => policy.key.toLowerCase() === normalized || policy.displayName.toLowerCase() === normalized,
    ) ?? null
  );
}

export function findActivePolicies() {
  return prisma.reportTypePolicy.findMany({ where: { isActive: true } });
}
