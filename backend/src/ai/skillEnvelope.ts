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
