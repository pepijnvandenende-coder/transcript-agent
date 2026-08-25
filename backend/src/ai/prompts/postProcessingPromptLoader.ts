import { readFileSync } from "node:fs";
import path from "node:path";

// Phase 18: the post-processing equivalent of reportTypeLoader.ts -- a
// post_processing_skill_policies row's `promptRef` resolves to a file here,
// not to code, so a new follow-up skill's Dutch instructions are one prompt
// file plus one catalog row, no change to postProcessingRunner.ts itself.
const PROMPTS_ROOT = path.join(__dirname, "postProcessing");
const cache = new Map<string, string>();

export function loadPostProcessingPrompt(promptRef: string): string {
  const cached = cache.get(promptRef);
  if (cached !== undefined) return cached;

  const target = path.join(PROMPTS_ROOT, promptRef);
  const content = readFileSync(target, "utf8");
  cache.set(promptRef, content);
  return content;
}
