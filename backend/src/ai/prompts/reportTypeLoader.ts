import { readFileSync } from "node:fs";
import path from "node:path";

// The one place a report_type_policies row's `promptRef` turns into actual
// prompt text. Files are static content bundled with the source (not
// runtime/user data, unlike src/storage), so they're resolved relative to
// this module rather than through STORAGE_ROOT_DIR. Cached in memory since
// prompt files don't change while the process is running.
const PROMPTS_ROOT = path.join(__dirname, "reportTypes");
const cache = new Map<string, string>();

export function loadReportTypePrompt(promptRef: string): string {
  const cached = cache.get(promptRef);
  if (cached !== undefined) return cached;

  const target = path.join(PROMPTS_ROOT, promptRef);
  const content = readFileSync(target, "utf8");
  cache.set(promptRef, content);
  return content;
}
