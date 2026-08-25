import { describe, expect, it } from "vitest";
import { parseContentBlocks, parseOpenQuestionBlocks } from "./parseContentBlocks";

describe("rendering/parseContentBlocks", () => {
  it("parses a markdown table into headers and rows", () => {
    const content = "| Actie | Verantwoordelijke | Deadline | Status |\n|---|---|---|---|\n| Actie A | Jan |  | Open |";
    const blocks = parseContentBlocks(content);
    expect(blocks).toEqual([
      {
        type: "table",
        headers: ["Actie", "Verantwoordelijke", "Deadline", "Status"],
        rows: [["Actie A", "Jan", "", "Open"]],
      },
    ]);
  });

  it("parses bullet lines into a bullets block", () => {
    const blocks = parseContentBlocks("- eerste\n- tweede");
    expect(blocks).toEqual([{ type: "bullets", items: ["eerste", "tweede"] }]);
  });

  it("parses plain lines as separate paragraphs", () => {
    const blocks = parseContentBlocks("Eerste zin.\nTweede zin.");
    expect(blocks).toEqual([
      { type: "paragraph", text: "Eerste zin." },
      { type: "paragraph", text: "Tweede zin." },
    ]);
  });

  describe("parseOpenQuestionBlocks", () => {
    it("splits blank-line-separated groups into separate blocks", () => {
      const content = "Vraag 1:\nWat is de scope?\n\nVraag 2:\nWie is verantwoordelijk?";
      expect(parseOpenQuestionBlocks(content)).toEqual(["Vraag 1:\nWat is de scope?", "Vraag 2:\nWie is verantwoordelijk?"]);
    });

    it("keeps a label and its duiding as one block (no blank line between them)", () => {
      const blocks = parseOpenQuestionBlocks("Vraag 1:\nWat is de scope?");
      expect(blocks).toEqual(["Vraag 1:\nWat is de scope?"]);
    });

    it("returns an empty array for empty or whitespace-only content", () => {
      expect(parseOpenQuestionBlocks("")).toEqual([]);
      expect(parseOpenQuestionBlocks("   \n\n  ")).toEqual([]);
    });
  });
});
