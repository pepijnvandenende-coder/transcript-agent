// Phase 15 item 3: DraftGenerator sometimes writes multiple bullet points as
// one unbroken string using "•" as an inline separator instead of real line
// breaks (e.g. "• eerste punt • tweede punt • derde punt"), which then
// displays as one unreadable line downstream (React, Markdown, Word). Pure
// text normalization, applied once right after parsing the model's
// response -- no prompt or model-call change. Content that's already
// newline-separated, or that contains no "•" marker at all, is returned
// unchanged.
export function normalizeSectionContent(content: string): string {
  if (!content.includes("•")) return content;

  return content
    .split("•")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => `• ${part}`)
    .join("\n");
}
