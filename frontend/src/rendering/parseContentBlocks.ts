// Phase 16 item 2: a frontend mirror of the backend's rendering/parseContentBlocks.ts,
// used so a section's content string (e.g. the "Acties en vervolgstappen"
// markdown table the report prompts already ask the model for -- see
// backend/src/ai/prompts/reportTypes/{thematic,qa}.md) renders as a real
// table on screen instead of one <p> per pipe-delimited line. Duplicated
// rather than shared: frontend and backend are two independent npm packages
// with no shared types/utils package (see api-client/client.ts's own doc
// comment on that same tradeoff).
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
