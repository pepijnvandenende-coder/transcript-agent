import { describe, expect, it } from "vitest";
import { loadReportTypePrompt } from "../../src/ai/prompts/reportTypeLoader";

// Phase 16 item 2: found via a real end-to-end browser test -- with no
// explicit instruction, DraftGenerator filled an unknown deadline cell with
// invented filler text ("Nog niet afgesproken") instead of leaving it empty.
// Both report type prompts must carry the same "don't invent, leave blank"
// rule DraftReviser's REVISION_INSTRUCTIONS already state for a revision, so
// a *first* generation doesn't fabricate a deadline placeholder either.
describe("ai/prompts/reportTypes deadline instruction", () => {
  it.each(["thematic.md", "qa.md"])("%s instructs the model to leave an unknown deadline cell empty, not fill it with placeholder text", (promptRef) => {
    const prompt = loadReportTypePrompt(promptRef);
    expect(prompt).toMatch(/deadline.*(alleen|leeg)/is);
    expect(prompt.toLowerCase()).toContain("laat de deadline-cel dan leeg");
  });
});
