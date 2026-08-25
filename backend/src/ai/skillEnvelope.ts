import { z } from "zod";

// The shared envelope every AI skill's output is wrapped in, per the
// architecture doc's AI Skill Contract. `result` is skill-specific --
// each skill module extends this schema with its own result shape.
export const SkillEnvelopeSchema = z.object({
  skill: z.string(),
  schema_version: z.string(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  flags: z.array(z.string()),
  result: z.unknown(),
});
export type SkillEnvelope = z.infer<typeof SkillEnvelopeSchema>;

export const TranscriptQualityResultSchema = z.object({
  sufficient: z.boolean(),
  issues: z.array(z.string()),
  metrics: z.record(z.number()),
});
export type TranscriptQualityResult = z.infer<typeof TranscriptQualityResultSchema>;

export const TranscriptQualityEnvelopeSchema = SkillEnvelopeSchema.extend({
  result: TranscriptQualityResultSchema,
});
export type TranscriptQualityEnvelope = z.infer<typeof TranscriptQualityEnvelopeSchema>;

export const MergedSectionSchema = z.object({
  heading: z.string(),
  content: z.string(),
  source: z.enum(["transcript", "notes", "both"]),
});
export type MergedSection = z.infer<typeof MergedSectionSchema>;

export const MergerResultSchema = z.object({
  merged_sections: z.array(MergedSectionSchema),
  unmatched_notes: z.array(z.string()),
  // Phase 13: lets approval/policyResolver.ts's semantic hook distinguish
  // "confidence is low because there was genuinely nothing to reconcile
  // between two sources" from real merge uncertainty, without the hook
  // needing access to anything beyond this skill's own result.
  notes_provided: z.boolean(),
});
export type MergerResult = z.infer<typeof MergerResultSchema>;

export const MergerEnvelopeSchema = SkillEnvelopeSchema.extend({
  result: MergerResultSchema,
});
export type MergerEnvelope = z.infer<typeof MergerEnvelopeSchema>;

export const ConflictSchema = z.object({
  description: z.string(),
  source_a: z.string().optional(),
  source_b: z.string().optional(),
});
export type Conflict = z.infer<typeof ConflictSchema>;

export const ConflictDetectorResultSchema = z.object({
  conflicts: z.array(ConflictSchema),
});
export type ConflictDetectorResult = z.infer<typeof ConflictDetectorResultSchema>;

export const ConflictDetectorEnvelopeSchema = SkillEnvelopeSchema.extend({
  result: ConflictDetectorResultSchema,
});
export type ConflictDetectorEnvelope = z.infer<typeof ConflictDetectorEnvelopeSchema>;

export const ReportTypeResultSchema = z.object({
  suggested_type: z.string(),
  rationale: z.string(),
  runner_up: z.string().optional(),
});
export type ReportTypeResult = z.infer<typeof ReportTypeResultSchema>;

export const ReportTypeAdvisorEnvelopeSchema = SkillEnvelopeSchema.extend({
  result: ReportTypeResultSchema,
});
export type ReportTypeAdvisorEnvelope = z.infer<typeof ReportTypeAdvisorEnvelopeSchema>;

// Phase 6: DraftGenerator's result. `sections` holds only the long-form
// Dutch content sections (Samenvatting, Notulen, ...) -- header metadata
// (title/attendees/date/subject) are their own fields, per the structure
// shared by both report_type_policies prompts (see
// src/ai/prompts/reportTypes/{thematic,qa}.md).
export const DraftSectionSchema = z.object({
  heading: z.string(),
  content: z.string(),
});
export type DraftSection = z.infer<typeof DraftSectionSchema>;

export const DraftGeneratorResultSchema = z.object({
  report_type: z.string(),
  title: z.string(),
  attendees: z.array(z.string()),
  date: z.string(),
  subject: z.string(),
  sections: z.array(DraftSectionSchema),
  coverage: z.number().min(0).max(1).optional(),
  // Single source of truth for whether the source contains concrete
  // actions/vervolgstappen -- see draftGenerator.ts's ACTIONS_SECTION_HEADING
  // handling and prisma/schema.prisma's Draft.actionsPresent.
  actions_present: z.boolean(),
});
export type DraftGeneratorResult = z.infer<typeof DraftGeneratorResultSchema>;

export const DraftGeneratorEnvelopeSchema = SkillEnvelopeSchema.extend({
  result: DraftGeneratorResultSchema,
});
export type DraftGeneratorEnvelope = z.infer<typeof DraftGeneratorEnvelopeSchema>;

// Phase 7: DraftQualityPrecheck's result -- ADVISORY_ONLY, never gates (see
// approval/gateway.ts's DraftQualityPrecheck SKILL_ROUTING entry). One
// checklist item per the resolved ReportTypePolicy's requiredSections.
//
// Phase 19 item 1: a plain `passed: boolean` can't tell a human reviewer
// "this is fine, the source just didn't mention it" apart from "this needs
// your attention" -- both used to render as the same failing marker. Four
// statuses instead: `ok` (check passed), `info` (nothing to flag -- the
// underlying information simply isn't in the source, e.g. no actions were
// discussed), `warning` (worth a human look, but not a reason to distrust
// the draft on its own), `problem` (the draft has nothing meaningful to
// review, e.g. no content sections at all). `detail` carries the concrete,
// per-item explanation a reviewer needs to act on a non-`ok` status --
// see draftQualityPrecheck.ts.
export const PrecheckStatusSchema = z.enum(["ok", "info", "warning", "problem"]);
export type PrecheckStatus = z.infer<typeof PrecheckStatusSchema>;

export const PrecheckChecklistItemSchema = z.object({
  item: z.string(),
  status: PrecheckStatusSchema,
  detail: z.string(),
});
export type PrecheckChecklistItem = z.infer<typeof PrecheckChecklistItemSchema>;

export const DraftQualityPrecheckResultSchema = z.object({
  overall_score: z.number().min(0).max(1),
  checklist: z.array(PrecheckChecklistItemSchema),
  blocking_issues: z.array(z.string()),
  recommendation: z.string(),
});
export type DraftQualityPrecheckResult = z.infer<typeof DraftQualityPrecheckResultSchema>;

export const DraftQualityPrecheckEnvelopeSchema = SkillEnvelopeSchema.extend({
  result: DraftQualityPrecheckResultSchema,
});
export type DraftQualityPrecheckEnvelope = z.infer<typeof DraftQualityPrecheckEnvelopeSchema>;

// Phase 8: DraftReviser's result -- MANDATORY, same unconditional-single-edge
// shape as ReportTypeAdvisor/DraftGenerator (see approval/gateway.ts's
// DraftReviser SKILL_ROUTING entry). Narrower than DraftGeneratorResult --
// no title/attendees/date/subject/report_type, since a revision only changes
// content; the runner carries those over from the draft being revised.
export const DraftReviserResultSchema = z.object({
  sections: z.array(DraftSectionSchema),
  changes_applied: z.array(z.string()),
  unresolved_feedback: z.array(z.string()),
  // Same single source of truth as DraftGeneratorResult.actions_present,
  // re-derived on every revision since the source/feedback re-examined here
  // can change the answer.
  actions_present: z.boolean(),
});
export type DraftReviserResult = z.infer<typeof DraftReviserResultSchema>;

export const DraftReviserEnvelopeSchema = SkillEnvelopeSchema.extend({
  result: DraftReviserResultSchema,
});
export type DraftReviserEnvelope = z.infer<typeof DraftReviserEnvelopeSchema>;

// Phase 9: FinalRenderer's result -- AUTO, the sparsest result of any skill
// (architecture doc: "rendered: true, typically template-only, no LLM"). The
// actual rendered content lives in object storage (see
// ai/skills/finalRenderer.ts's renderContent()), not in this envelope.
export const FinalRendererResultSchema = z.object({
  rendered: z.literal(true),
});
export type FinalRendererResult = z.infer<typeof FinalRendererResultSchema>;

export const FinalRendererEnvelopeSchema = SkillEnvelopeSchema.extend({
  result: FinalRendererResultSchema,
});
export type FinalRendererEnvelope = z.infer<typeof FinalRendererEnvelopeSchema>;

// Phase 18: the POST_PROCESSING orchestrator's own envelope -- one row per
// workflow, summarizing which of the active post_processing_skill_policies
// actually ran. The sub-skills' own raw output is NOT nested in here -- each
// gets its own ai_outputs governance row (see the OpenQuestionsAnalyzer/
// CriteriaCoverageAnalyzer schemas below) and its own post_processing_results
// row, mirroring how every other multi-row-writing skill (Merger, DraftGenerator,
// ...) keeps its own governance envelope separate from the domain rows it writes.
export const PostProcessingResultStatusSchema = z.enum(["completed", "failed", "skipped"]);

export const PostProcessingExecutionSchema = z.object({
  skill_key: z.string(),
  status: PostProcessingResultStatusSchema,
});
export type PostProcessingExecution = z.infer<typeof PostProcessingExecutionSchema>;

export const PostProcessingResultSchema = z.object({
  executed: z.array(PostProcessingExecutionSchema),
});
export type PostProcessingOrchestratorResult = z.infer<typeof PostProcessingResultSchema>;

export const PostProcessingEnvelopeSchema = SkillEnvelopeSchema.extend({
  result: PostProcessingResultSchema,
});
export type PostProcessingEnvelope = z.infer<typeof PostProcessingEnvelopeSchema>;

// Phase 18: OpenQuestionsAnalyzer's result -- one of the two example
// follow-up skills. `question`/`explanation` are Dutch prose (per the
// codebase's "Dutch AI output" rule); the field names themselves stay
// English, matching every other skill's result schema.
export const OpenQuestionSchema = z.object({
  question: z.string(),
  explanation: z.string(),
});
export type OpenQuestion = z.infer<typeof OpenQuestionSchema>;

export const OpenQuestionsResultSchema = z.object({
  open_questions: z.array(OpenQuestionSchema),
});
export type OpenQuestionsResult = z.infer<typeof OpenQuestionsResultSchema>;

export const OpenQuestionsEnvelopeSchema = SkillEnvelopeSchema.extend({
  result: OpenQuestionsResultSchema,
});
export type OpenQuestionsEnvelope = z.infer<typeof OpenQuestionsEnvelopeSchema>;

// Phase 18: CriteriaCoverageAnalyzer's result -- the second example
// follow-up skill, only ever run when a "normenkader" context_items row
// exists (see postProcessingRunner.ts). One row per criterion/norm the model
// identified in the supplied context, each judged against the final report.
export const CriteriaCoverageStatusSchema = z.enum(["covered", "partially_covered", "not_covered"]);

export const CriteriaCoverageItemSchema = z.object({
  criterion: z.string(),
  status: CriteriaCoverageStatusSchema,
  explanation: z.string(),
});
export type CriteriaCoverageItem = z.infer<typeof CriteriaCoverageItemSchema>;

export const CriteriaCoverageResultSchema = z.object({
  items: z.array(CriteriaCoverageItemSchema),
});
export type CriteriaCoverageResult = z.infer<typeof CriteriaCoverageResultSchema>;

export const CriteriaCoverageEnvelopeSchema = SkillEnvelopeSchema.extend({
  result: CriteriaCoverageResultSchema,
});
export type CriteriaCoverageEnvelope = z.infer<typeof CriteriaCoverageEnvelopeSchema>;
