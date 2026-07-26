import { PolicyType, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// One approval_policies row per registered skill, per docs/architecture/README.md's
// Confidence Scoring policy table. Later phases add their own skill's row
// here as each skill is built; this seed is additive/idempotent (upsert), so
// re-running it is always safe.
async function main() {
  await prisma.approvalPolicy.upsert({
    where: { skillName: "TranscriptQualityChecker" },
    update: { policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.75 },
    create: {
      skillName: "TranscriptQualityChecker",
      policyType: PolicyType.AUTO_IF_ABOVE,
      confidenceThreshold: 0.75,
    },
  });

  await prisma.approvalPolicy.upsert({
    where: { skillName: "Merger" },
    update: { policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.8 },
    create: {
      skillName: "Merger",
      policyType: PolicyType.AUTO_IF_ABOVE,
      confidenceThreshold: 0.8,
    },
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
