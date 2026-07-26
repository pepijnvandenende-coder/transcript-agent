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
});
export type DraftGeneratorResult = z.infer<typeof DraftGeneratorResultSchema>;

export const DraftGeneratorEnvelopeSchema = SkillEnvelopeSchema.extend({
  result: DraftGeneratorResultSchema,
});
export type DraftGeneratorEnvelope = z.infer<typeof DraftGeneratorEnvelopeSchema>;

// Phase 7: DraftQualityPrecheck's result -- ADVISORY_ONLY, never gates (see
// approval/gateway.ts's DraftQualityPrecheck SKILL_ROUTING entry). One
// checklist item per the resolved ReportTypePolicy's requiredSections.
export const PrecheckChecklistItemSchema = z.object({
  item: z.string(),
  passed: z.boolean(),
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
});
export type DraftReviserResult = z.infer<typeof DraftReviserResultSchema>;

export const DraftReviserEnvelopeSchema = SkillEnvelopeSchema.extend({
  result: DraftReviserResultSchema,
});
export type DraftReviserEnvelope = z.infer<typeof DraftReviserEnvelopeSchema>;
