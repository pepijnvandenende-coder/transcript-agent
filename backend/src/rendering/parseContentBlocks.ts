// Phase 15 item 4: shared by the Word renderer (finalRenderer.ts) to turn a
// section's `content` string into real Word structures (tables, bulleted
// lists, paragraphs) instead of visible Markdown syntax. Pure text parsing,
// no model call, no prompt dependency -- the Dutch prompts (thematic.md/
// qa.md) already write bullet lines ("- item") and Markdown tables
// ("| Actie | ... |") for exactly this content, this only recognizes what's
// already there.
export type ContentBlock =
  | { type: "paragraph"; text: string }
  | { type: "bullets"; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] };

const BULLET_LINE = /^[-•*]\s+(.*)$/;
const TABLE_ROW = /^\|.*\|$/;
const TABLE_SEPARATOR_ROW = /^\|(\s*:?-+:?\s*\|)+$/;

function parseTableRow(line: string): string[] {
  return line
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

export function parseContentBlocks(content: string): ContentBlock[] {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const blocks: ContentBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEPARATOR_ROW.test(lines[i + 1])) {
      const headers = parseTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i]) && !TABLE_SEPARATOR_ROW.test(lines[i])) {
        rows.push(parseTableRow(lines[i]));
        i++;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    const bulletMatch = line.match(BULLET_LINE);
    if (bulletMatch) {
      const items: string[] = [];
      while (i < lines.length) {
        const match = lines[i].match(BULLET_LINE);
        if (!match) break;
        items.push(match[1].trim());
        i++;
      }
      blocks.push({ type: "bullets", items });
      continue;
    }

    blocks.push({ type: "paragraph", text: line });
    i++;
  }

  return blocks;
}
