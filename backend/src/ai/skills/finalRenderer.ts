import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from "docx";
import type { DraftSection, FinalRendererEnvelope } from "../skillEnvelope";
import { type ContentBlock, parseContentBlocks } from "../../rendering/parseContentBlocks";

// Phase 9: the last skill in the pipeline. Per the architecture doc,
// FinalRenderer is "typically template-only, no LLM" -- unlike every earlier
// skill's "stub-1" convention (a placeholder standing in for a future LLM
// call), this one is deliberately versioned "template-1": the doc frames it
// as staying template-only, not as awaiting an eventual LLM upgrade. Phase
// 15 item 4 adds renderDocx() as the primary final-report format
// (jobs/runners/finalRendererRunner.ts); renderContent() (Markdown) is kept
// available as an internal/secondary format, per the approved plan.
export const SKILL_NAME = "FinalRenderer";
export const SCHEMA_VERSION = "1.0.0";
export const PROMPT_VERSION = "template-1";

// Deterministic template: header fields (echoing the approved Draft
// verbatim -- no assumptions/new facts) followed by every section's heading
// and content, unchanged. Separate from run() so the actual rendered content
// is directly testable without going through the trivial envelope.
export function renderContent(params: {
  title: string;
  attendees: string[];
  date: string;
  subject: string;
  sections: DraftSection[];
}): string {
  const { title, attendees, date, subject, sections } = params;
  const header = [
    `Titel: ${title}`,
    `Aanwezige deelnemers: ${attendees.length > 0 ? attendees.join(", ") : "Niet vastgelegd"}`,
    `Datum: ${date}`,
    `Onderwerp: ${subject}`,
  ].join("\n");

  const body = sections.map((section) => `## ${section.heading}\n\n${section.content}`).join("\n\n");

  return `${header}\n\n${body}\n`;
}

// A section the model wrote a heading for but left effectively empty --
// the Dutch prompts frame every optional section as "indien van
// toepassing" (Acties en vervolgstappen / Openstaande vragen / Bijlagen),
// so an empty or explicit "n.v.t." placeholder means it doesn't apply here
// and shouldn't render as a bare heading with no content.
const NOT_APPLICABLE_PATTERN = /^(n\.?v\.?t\.?|niet van toepassing|geen)\.?$/i;

export function isApplicableSection(section: DraftSection): boolean {
  const trimmed = section.content.trim();
  return trimmed.length > 0 && !NOT_APPLICABLE_PATTERN.test(trimmed);
}

// Phase 16 item 4: explicit spacing (in twips -- twentieths of a point, the
// unit docx/OOXML paragraph spacing uses) on every paragraph/heading rather
// than relying on the library's built-in style defaults, so the output
// reads as a deliberately laid-out document -- blank-line-equivalent gaps
// between text blocks, and a heading always visually separated from both
// the text above it (space before) and below it (space after) regardless
// of what kind of block precedes it (paragraph, bullet list, or table).
const PARAGRAPH_SPACING = { after: 200 };
const BULLET_SPACING = { after: 80 };
const HEADING1_SPACING = { after: 240 };
const HEADING2_SPACING = { before: 360, after: 160 };

function blockToDocxElements(block: ContentBlock): Array<Paragraph | Table> {
  if (block.type === "paragraph") {
    return [new Paragraph({ text: block.text, spacing: PARAGRAPH_SPACING })];
  }
  if (block.type === "bullets") {
    return block.items.map((item) => new Paragraph({ text: item, bullet: { level: 0 }, spacing: BULLET_SPACING }));
  }
  const headerRow = new TableRow({
    children: block.headers.map(
      (header) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: header, bold: true })] })] }),
    ),
  });
  const dataRows = block.rows.map(
    (row) => new TableRow({ children: row.map((cell) => new TableCell({ children: [new Paragraph({ text: cell })] })) }),
  );
  return [new Table({ rows: [headerRow, ...dataRows] })];
}

// Real Word structures throughout -- Titel as Heading 1, every section
// heading as Heading 2, Markdown tables/bullets in section content turned
// into actual docx.Table/bulleted docx.Paragraph via parseContentBlocks(),
// no visible Markdown syntax. Optional sections the model left inapplicable
// are skipped entirely rather than rendered as an empty heading.
export function renderDocx(params: {
  title: string;
  attendees: string[];
  date: string;
  subject: string;
  sections: DraftSection[];
}): Promise<Buffer> {
  const { title, attendees, date, subject, sections } = params;

  const children: Array<Paragraph | Table> = [
    new Paragraph({ text: title, heading: HeadingLevel.HEADING_1, spacing: HEADING1_SPACING }),
    new Paragraph({
      text: `Aanwezige deelnemers: ${attendees.length > 0 ? attendees.join(", ") : "Niet vastgelegd"}`,
      spacing: PARAGRAPH_SPACING,
    }),
    new Paragraph({ text: `Datum: ${date}`, spacing: PARAGRAPH_SPACING }),
    new Paragraph({ text: `Onderwerp: ${subject}`, spacing: PARAGRAPH_SPACING }),
  ];

  for (const section of sections) {
    if (!isApplicableSection(section)) continue;
    children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_2, spacing: HEADING2_SPACING }));
    for (const block of parseContentBlocks(section.content)) {
      children.push(...blockToDocxElements(block));
    }
  }

  const document = new Document({ sections: [{ children }] });
  return Packer.toBuffer(document);
}

export function run(): FinalRendererEnvelope {
  return {
    skill: SKILL_NAME,
    schema_version: SCHEMA_VERSION,
    confidence: 1,
    rationale: "Deterministic template rendering of the approved draft -- no LLM involved.",
    flags: [],
    result: { rendered: true },
  };
}
