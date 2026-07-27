import { describe, expect, it } from "vitest";
import { parseContentBlocks } from "./parseContentBlocks";

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
});
