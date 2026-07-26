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
