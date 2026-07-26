import type { z } from "zod";
import { MergerEnvelopeSchema, TranscriptQualityEnvelopeSchema } from "../ai/skillEnvelope";

export interface SchemaCheckResult {
  valid: boolean;
  errors?: unknown;
}

// Maps skill_name -> the envelope schema its raw_output must satisfy. Each
// new skill registers its schema here rather than growing a chain of
// if/else.
const SCHEMAS: Record<string, z.ZodTypeAny> = {
  TranscriptQualityChecker: TranscriptQualityEnvelopeSchema,
  Merger: MergerEnvelopeSchema,
};

export function checkSchema(skillName: string, rawOutput: unknown): SchemaCheckResult {
  const schema = SCHEMAS[skillName];
  if (!schema) {
    return { valid: false, errors: [`No schema registered for skill "${skillName}"`] };
  }
  const parsed = schema.safeParse(rawOutput);
  if (parsed.success) return { valid: true };
  return { valid: false, errors: parsed.error.issues };
}
