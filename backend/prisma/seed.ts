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

  // MANDATORY, unconditionally -- no confidence threshold applies (matches
  // the architecture doc's policy table's "n/a"). See approval/gateway.ts's
  // bypassEvent routing shape for how this always proceeds straight to
  // AWAITING_REPORT_TYPE_SELECTION regardless of confidence or schema validity.
  await prisma.approvalPolicy.upsert({
    where: { skillName: "ReportTypeAdvisor" },
    update: { policyType: PolicyType.MANDATORY, confidenceThreshold: null },
    create: {
      skillName: "ReportTypeAdvisor",
      policyType: PolicyType.MANDATORY,
    },
  });

  // Phase 6: DraftGenerator is MANDATORY unconditionally, same shape as
  // ReportTypeAdvisor -- see approval/gateway.ts's bypassEvent routing.
  await prisma.approvalPolicy.upsert({
    where: { skillName: "DraftGenerator" },
    update: { policyType: PolicyType.MANDATORY, confidenceThreshold: null },
    create: {
      skillName: "DraftGenerator",
      policyType: PolicyType.MANDATORY,
    },
  });

  // Phase 7: ADVISORY_ONLY, unconditionally -- no confidence threshold
  // applies (matches the architecture doc's policy table). See
  // approval/gateway.ts's DraftQualityPrecheck routing entry: this resolves
  // to policyResolver.ts's "auto_approved" outcome regardless of confidence,
  // so the precheck always auto-approves and proceeds to DRAFT_PENDING_REVIEW.
  await prisma.approvalPolicy.upsert({
    where: { skillName: "DraftQualityPrecheck" },
    update: { policyType: PolicyType.ADVISORY_ONLY, confidenceThreshold: null },
    create: {
      skillName: "DraftQualityPrecheck",
      policyType: PolicyType.ADVISORY_ONLY,
    },
  });

  // Phase 6: the report generation policy catalog. Metadata only (English
  // columns) -- the actual Dutch prompt instructions live in
  // src/ai/prompts/reportTypes/{key}.md, referenced by promptRef. Adding a
  // third report type later is one more upsert here plus one prompt file --
  // no code changes to draftGenerator.ts or its runner.
  await prisma.reportTypePolicy.upsert({
    where: { key: "thematic" },
    update: {
      displayName: "Thematisch gespreksverslag",
      language: "nl",
      promptVersion: "v1",
      promptRef: "thematic.md",
      requiredSections: ["Samenvatting", "Notulen"],
      optionalSections: [
        "Acties en vervolgstappen",
        "Openstaande vragen / onduidelijkheden",
        "Bijlagen/verwijzingen",
      ],
      isActive: true,
    },
    create: {
      key: "thematic",
      displayName: "Thematisch gespreksverslag",
      language: "nl",
      promptVersion: "v1",
      promptRef: "thematic.md",
      requiredSections: ["Samenvatting", "Notulen"],
      optionalSections: [
        "Acties en vervolgstappen",
        "Openstaande vragen / onduidelijkheden",
        "Bijlagen/verwijzingen",
      ],
    },
  });

  await prisma.reportTypePolicy.upsert({
    where: { key: "qa" },
    update: {
      displayName: "Vraag & antwoord gespreksverslag",
      language: "nl",
      promptVersion: "v1",
      promptRef: "qa.md",
      requiredSections: ["Samenvatting", "Notulen"],
      optionalSections: [
        "Acties en vervolgstappen",
        "Openstaande vragen / onduidelijkheden",
        "Bijlagen/verwijzingen",
      ],
      isActive: true,
    },
    create: {
      key: "qa",
      displayName: "Vraag & antwoord gespreksverslag",
      language: "nl",
      promptVersion: "v1",
      promptRef: "qa.md",
      requiredSections: ["Samenvatting", "Notulen"],
      optionalSections: [
        "Acties en vervolgstappen",
        "Openstaande vragen / onduidelijkheden",
        "Bijlagen/verwijzingen",
      ],
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
