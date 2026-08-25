import type { DraftReviserEnvelope, DraftSection } from "../skillEnvelope";
import { getAnthropicClient } from "../anthropicClient";
import { normalizeSectionContent } from "../normalizeSectionContent";
import { loadReportTypePrompt } from "../prompts/reportTypeLoader";
import { ACTIONS_PRESENCE_INSTRUCTIONS, ACTIONS_SECTION_HEADING } from "./draftGenerator";

// Phase 16: replaces the Phase 8 deterministic stub (which only ever
// appended feedback verbatim onto a hardcoded "Notulen" heading) with a real
// Anthropic API call, following the same pattern draftGenerator.ts used in
// Phase 11. The stub could never honour feedback like "zet acties in een
// tabel" or "verwijder de acties" -- it had no way to restructure or remove
// content, only append to one fixed section. This call is given the full
// original source, the current draft, and the reviewer feedback, and is
// instructed (REVISION_INSTRUCTIONS below) to actually reshape the sections
// -- including dropping the standard format -- rather than layering
// additions on top of it.
export const SKILL_NAME = "DraftReviser";
export const SCHEMA_VERSION = "1.0.0";
export const PROMPT_VERSION = "llm-1";

const MODEL = "claude-opus-4-8";
const MAX_TOKENS = 8000;

// The report type's own prompt file is included as the system prompt's base
// (same structure/context DraftGenerator used to produce this draft in the
// first place), with this block appended to make feedback-driven change the
// dominant instruction for a revision pass -- see the Phase 16 plan item 3.
const REVISION_INSTRUCTIONS = `
Je bent nu niet aan het genereren, maar verantwoordelijk voor het aanpassen van een al bestaand gespreksverslag op basis van feedback van de gebruiker.

Voer iedere gevraagde wijziging daadwerkelijk door. De feedback van de gebruiker heeft voorrang boven het standaardformat hierboven.

Als de gebruiker vraagt om:
- een onderdeel te verwijderen: laat dat onderdeel volledig weg uit de sections-lijst (geen kop, geen inhoud, ook niet leeg);
- een onderdeel anders te structureren (bijvoorbeeld als tabel): pas de structuur van de inhoud daadwerkelijk aan, bijvoorbeeld als een markdown-tabel ("| kolom | kolom |" met een scheidingsregel eronder);
- af te wijken van het standaardformat: volg de wens van de gebruiker, ook als daardoor een standaardonderdeel wegvalt of van vorm verandert.

Behoud alleen informatie die na de wijziging nog relevant is. Doe nooit alsof een wijziging is doorgevoerd terwijl de inhoud in werkelijkheid ongewijzigd blijft ten opzichte van de huidige conceptversie -- de nieuwe sections-lijst moet de daadwerkelijke, zichtbare weerslag van de feedback zijn, niet de oude inhoud met een toevoeging erachter geplakt.

Vul in een actietabel nooit een deadline in tenzij deze letterlijk in de brontekst of aantekeningen wordt genoemd. Is er geen deadline genoemd, laat de deadline-cel dan leeg.

Meld voor elk feedbackpunt in "changes_applied" wat je concreet hebt aangepast. Als een feedbackpunt niet kon worden verwerkt (bijvoorbeeld omdat het naar iets verwijst dat niet in het verslag voorkomt), zet dat feedbackpunt dan in "unresolved_feedback" in plaats van te doen alsof het is verwerkt.

Herbeoordeel "actions_present" hieronder opnieuw op basis van de brontekst (niet op basis van wat de vorige conceptversie toevallig al bevatte). Vraagt de feedback expliciet om de sectie "Acties en vervolgstappen" toe te voegen of te verwijderen, volg die feedback net als bij ieder ander onderdeel -- maar verzin nooit een actie die niet daadwerkelijk uit de bron blijkt.
`.trim();

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          heading: { type: "string" },
          content: { type: "string" },
        },
        required: ["heading", "content"],
        additionalProperties: false,
      },
    },
    changes_applied: { type: "array", items: { type: "string" } },
    unresolved_feedback: { type: "array", items: { type: "string" } },
    actions_present: {
      type: "boolean",
      description:
        "Of de brontekst daadwerkelijk concrete, afgesproken acties/vervolgstappen bevat -- zie de aparte instructie hierboven. Bindend voor of 'Acties en vervolgstappen' in sections voorkomt.",
    },
  },
  required: ["sections", "changes_applied", "unresolved_feedback", "actions_present"],
  additionalProperties: false,
} as const;

interface DraftReviserLlmOutput {
  sections: Array<{ heading: string; content: string }>;
  changes_applied: string[];
  unresolved_feedback: string[];
  actions_present: boolean;
}

function formatCurrentDraft(sections: DraftSection[]): string {
  return sections.map((section) => `## ${section.heading}\n${section.content}`).join("\n\n");
}

function formatFeedback(feedbackItems: string[]): string {
  return feedbackItems.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

export async function run(params: {
  mergedContent: string;
  promptRef: string;
  subject: string;
  previousSections: DraftSection[];
  feedbackItems: string[];
}): Promise<DraftReviserEnvelope> {
  const { mergedContent, promptRef, subject, previousSections, feedbackItems } = params;
  const systemPrompt = `${loadReportTypePrompt(promptRef)}\n\n${ACTIONS_PRESENCE_INSTRUCTIONS}\n\n${REVISION_INSTRUCTIONS}`;

  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    messages: [
      {
        role: "user",
        content: `Onderwerp: ${subject}\n\nOorspronkelijke bron (transcript en, indien aanwezig, eigen notities, al samengevoegd):\n\n${mergedContent}\n\nHuidige conceptversie van het gespreksverslag:\n\n${formatCurrentDraft(previousSections)}\n\nFeedback van de reviewer op deze conceptversie:\n\n${formatFeedback(feedbackItems)}`,
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const parsed: DraftReviserLlmOutput =
    textBlock && textBlock.type === "text"
      ? JSON.parse(textBlock.text)
      : {
          sections: previousSections,
          changes_applied: [],
          unresolved_feedback: feedbackItems,
          // Parse failure -- previousSections passes through unchanged, so
          // derive actions_present from what's actually still there rather
          // than guessing, keeping the enforcement filter below a no-op.
          actions_present: previousSections.some((section) => section.heading === ACTIONS_SECTION_HEADING),
        };

  // Same deterministic enforcement as draftGenerator.ts -- see its comment.
  const sections = parsed.sections.filter(
    (section) => parsed.actions_present || section.heading !== ACTIONS_SECTION_HEADING,
  );

  return {
    skill: SKILL_NAME,
    schema_version: SCHEMA_VERSION,
    // DraftReviser is a MANDATORY skill (see approval/policyResolver.ts) --
    // confidence is never consulted for routing, same reasoning as
    // draftGenerator.ts's fixed value.
    confidence: 1,
    rationale: `LLM-revised draft (${MODEL}) op basis van ${feedbackItems.length} feedbackregel(s).`,
    flags: [],
    result: {
      sections: sections.map((section) => ({ ...section, content: normalizeSectionContent(section.content) })),
      changes_applied: parsed.changes_applied,
      unresolved_feedback: parsed.unresolved_feedback,
      actions_present: parsed.actions_present,
    },
  };
}
