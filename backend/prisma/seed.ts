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

  // "MANDATORY if conflicts found" is enforced by ConflictDetector's semantic
  // hook in approval/policyResolver.ts, not by policyType -- this row governs
  // only the "no conflicts found" branch, mirroring how TranscriptQualityChecker's
  // `sufficient` hook already overrides its own AUTO_IF_ABOVE row today.
  await prisma.approvalPolicy.upsert({
    where: { skillName: "ConflictDetector" },
    update: { policyType: PolicyType.AUTO_IF_ABOVE, confidenceThreshold: 0.7 },
    create: {
      skillName: "ConflictDetector",
      policyType: PolicyType.AUTO_IF_ABOVE,
      confidenceThreshold: 0.7,
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
