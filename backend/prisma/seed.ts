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

  // Phase 8: DraftReviser is MANDATORY unconditionally, same shape as
  // ReportTypeAdvisor/DraftGenerator -- see approval/gateway.ts's bypassEvent
  // routing.
  await prisma.approvalPolicy.upsert({
    where: { skillName: "DraftReviser" },
    update: { policyType: PolicyType.MANDATORY, confidenceThreshold: null },
    create: {
      skillName: "DraftReviser",
      policyType: PolicyType.MANDATORY,
    },
  });

  // Phase 9: AUTO, unconditionally -- no confidence threshold applies
  // (matches the architecture doc's policy table). Distinct from
  // ADVISORY_ONLY: FinalRenderer has no advisory annotation and no
  // downstream human judgment at all, see approval/policyResolver.ts's AUTO
  // branch.
  await prisma.approvalPolicy.upsert({
    where: { skillName: "FinalRenderer" },
    update: { policyType: PolicyType.AUTO, confidenceThreshold: null },
    create: {
      skillName: "FinalRenderer",
      policyType: PolicyType.AUTO,
    },
  });

  // Phase 18: AUTO, unconditionally -- same shape as FinalRenderer above.
  // The orchestrator job itself never gates; individual follow-up skills'
  // success/failure is recorded per-row in post_processing_results instead
  // (see jobs/runners/postProcessingRunner.ts).
  await prisma.approvalPolicy.upsert({
    where: { skillName: "PostProcessing" },
    update: { policyType: PolicyType.AUTO, confidenceThreshold: null },
    create: {
      skillName: "PostProcessing",
      policyType: PolicyType.AUTO,
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
      promptVersion: "v2",
      promptRef: "thematic.md",
      requiredSections: ["Samenvatting"],
      optionalSections: [
        "Acties en vervolgstappen",
        "Openstaande vragen / onduidelijkheden",
        "Bijlagen/verwijzingen",
      ],
      bodyContentRule: { type: "topic_sections", minCount: 1 },
      isActive: true,
    },
    create: {
      key: "thematic",
      displayName: "Thematisch gespreksverslag",
      language: "nl",
      promptVersion: "v2",
      promptRef: "thematic.md",
      requiredSections: ["Samenvatting"],
      optionalSections: [
        "Acties en vervolgstappen",
        "Openstaande vragen / onduidelijkheden",
        "Bijlagen/verwijzingen",
      ],
      bodyContentRule: { type: "topic_sections", minCount: 1 },
    },
  });

  await prisma.reportTypePolicy.upsert({
    where: { key: "qa" },
    update: {
      displayName: "Vraag & antwoord gespreksverslag",
      language: "nl",
      promptVersion: "v2",
      promptRef: "qa.md",
      requiredSections: ["Samenvatting"],
      optionalSections: [
        "Acties en vervolgstappen",
        "Openstaande vragen / onduidelijkheden",
        "Bijlagen/verwijzingen",
      ],
      bodyContentRule: { type: "qa_pairs", minCount: 1 },
      isActive: true,
    },
    create: {
      key: "qa",
      displayName: "Vraag & antwoord gespreksverslag",
      language: "nl",
      promptVersion: "v2",
      promptRef: "qa.md",
      requiredSections: ["Samenvatting"],
      optionalSections: [
        "Acties en vervolgstappen",
        "Openstaande vragen / onduidelijkheden",
        "Bijlagen/verwijzingen",
      ],
      bodyContentRule: { type: "qa_pairs", minCount: 1 },
    },
  });

  // Phase 18: the additional-context type catalog. Deliberately not limited
  // to PvA/normenkader/vragenlijst -- "other" covers anything not yet worth
  // its own dedicated type, and new types can be added later as pure data
  // (an upsert here), no code change. isActive/sortOrder govern what the
  // frontend's context step actually offers.
  const contextTypes: Array<{
    key: string;
    displayName: string;
    description: string;
    instructionLabel: string;
    sortOrder: number;
  }> = [
    {
      key: "pva",
      displayName: "Plan van Aanpak (PvA)",
      description: "Het plan van aanpak dat als basis diende voor dit gesprek.",
      instructionLabel: "Plan van Aanpak (PvA)",
      sortOrder: 1,
    },
    {
      key: "normenkader",
      displayName: "Normenkader",
      description: "Het normenkader of de criteria waartegen dit gesprek beoordeeld wordt.",
      instructionLabel: "Normenkader",
      sortOrder: 2,
    },
    {
      key: "vragenlijst",
      displayName: "Vragenlijst",
      description: "De vragenlijst die als leidraad diende voor dit gesprek.",
      instructionLabel: "Vragenlijst",
      sortOrder: 3,
    },
    {
      key: "other",
      displayName: "Overige context",
      description: "Overige relevante documenten, instructies of aandachtspunten.",
      instructionLabel: "Overige context",
      sortOrder: 4,
    },
  ];

  for (const contextType of contextTypes) {
    await prisma.contextTypePolicy.upsert({
      where: { key: contextType.key },
      update: {
        displayName: contextType.displayName,
        description: contextType.description,
        instructionLabel: contextType.instructionLabel,
        sortOrder: contextType.sortOrder,
        isActive: true,
      },
      create: {
        key: contextType.key,
        displayName: contextType.displayName,
        description: contextType.description,
        instructionLabel: contextType.instructionLabel,
        sortOrder: contextType.sortOrder,
      },
    });
  }

  // Phase 18: the post-processing follow-up skill catalog. Two example
  // skills per the approved design -- open questions (no context
  // requirement) and criteria/norm coverage (requires a "normenkader"
  // context_items row; skipped otherwise, see postProcessingRunner.ts).
  await prisma.postProcessingSkillPolicy.upsert({
    where: { key: "open_questions" },
    update: {
      displayName: "Openstaande vragen",
      description: "Analyseert het gespreksverslag op onbeantwoorde vragen en ontbrekende informatie.",
      promptRef: "openQuestions.md",
      requiresContextType: null,
      sortOrder: 1,
      isActive: true,
    },
    create: {
      key: "open_questions",
      displayName: "Openstaande vragen",
      description: "Analyseert het gespreksverslag op onbeantwoorde vragen en ontbrekende informatie.",
      promptRef: "openQuestions.md",
      sortOrder: 1,
    },
  });

  await prisma.postProcessingSkillPolicy.upsert({
    where: { key: "norm_coverage" },
    update: {
      displayName: "Normenkader / criteria coverage",
      description: "Bepaalt welke normen of criteria in het gespreksverslag aan bod zijn gekomen.",
      promptRef: "criteriaCoverage.md",
      requiresContextType: "normenkader",
      sortOrder: 2,
      isActive: true,
    },
    create: {
      key: "norm_coverage",
      displayName: "Normenkader / criteria coverage",
      description: "Bepaalt welke normen of criteria in het gespreksverslag aan bod zijn gekomen.",
      promptRef: "criteriaCoverage.md",
      requiresContextType: "normenkader",
      sortOrder: 2,
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
