import { describe, expect, it } from "vitest";
import { parseContentBlocks } from "../../src/rendering/parseContentBlocks";

// Pure logic -- no database needed.
describe("rendering/parseContentBlocks", () => {
  it("parses plain lines as separate paragraph blocks", () => {
    const blocks = parseContentBlocks("Eerste zin.\nTweede zin.");
    expect(blocks).toEqual([
      { type: "paragraph", text: "Eerste zin." },
      { type: "paragraph", text: "Tweede zin." },
    ]);
  });

  it("parses consecutive '- ' lines as one bullets block", () => {
    const blocks = parseContentBlocks("- Eerste punt\n- Tweede punt\n- Derde punt");
    expect(blocks).toEqual([{ type: "bullets", items: ["Eerste punt", "Tweede punt", "Derde punt"] }]);
  });

  it("parses consecutive '• ' lines as one bullets block", () => {
    const blocks = parseContentBlocks("• Eerste punt\n• Tweede punt");
    expect(blocks).toEqual([{ type: "bullets", items: ["Eerste punt", "Tweede punt"] }]);
  });

  it("parses a Markdown table (header, separator, rows) as one table block", () => {
    const content = ["| Actie | Verantwoordelijke | Deadline | Status |", "|-------|-------------------|----------|--------|", "| Plan opstellen | Jan | 2026-02-01 | Open |"].join(
      "\n",
    );

    const blocks = parseContentBlocks(content);

    expect(blocks).toEqual([
      {
        type: "table",
        headers: ["Actie", "Verantwoordelijke", "Deadline", "Status"],
        rows: [["Plan opstellen", "Jan", "2026-02-01", "Open"]],
      },
    ]);
  });

  it("parses a table with multiple data rows", () => {
    const content = [
      "| Actie | Status |",
      "|-------|--------|",
      "| Plan opstellen | Open |",
      "| Review inplannen | Afgerond |",
    ].join("\n");

    const blocks = parseContentBlocks(content);

    expect(blocks).toEqual([
      {
        type: "table",
        headers: ["Actie", "Status"],
        rows: [
          ["Plan opstellen", "Open"],
          ["Review inplannen", "Afgerond"],
        ],
      },
    ]);
  });

  it("mixes paragraphs, bullets, and a table in one section, in order", () => {
    const content = [
      "Introductiezin.",
      "- Bullet een",
      "- Bullet twee",
      "Nog een zin.",
      "| Actie | Status |",
      "|-------|--------|",
      "| X | Open |",
    ].join("\n");

    const blocks = parseContentBlocks(content);

    expect(blocks).toEqual([
      { type: "paragraph", text: "Introductiezin." },
      { type: "bullets", items: ["Bullet een", "Bullet twee"] },
      { type: "paragraph", text: "Nog een zin." },
      { type: "table", headers: ["Actie", "Status"], rows: [["X", "Open"]] },
    ]);
  });

  it("returns an empty array for empty or whitespace-only content", () => {
    expect(parseContentBlocks("")).toEqual([]);
    expect(parseContentBlocks("   \n  \n")).toEqual([]);
  });

  it("ignores blank lines between blocks", () => {
    const blocks = parseContentBlocks("Eerste zin.\n\nTweede zin.");
    expect(blocks).toEqual([
      { type: "paragraph", text: "Eerste zin." },
      { type: "paragraph", text: "Tweede zin." },
    ]);
  });
});
