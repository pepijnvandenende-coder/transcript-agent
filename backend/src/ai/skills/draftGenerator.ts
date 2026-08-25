import type { DraftGeneratorEnvelope } from "../skillEnvelope";
import { getAnthropicClient } from "../anthropicClient";
import { normalizeSectionContent } from "../normalizeSectionContent";
import { loadReportTypePrompt } from "../prompts/reportTypeLoader";

// Phase 11: replaces the Phase 6 deterministic stub with a real Anthropic
// API call, per the approved Phase 11 plan (feedback item 6). The Dutch
// instruction prompts in ai/prompts/reportTypes/{thematic,qa}.md were
// written for exactly this purpose back in Phase 6 and, per
// prisma/schema.prisma's ReportTypePolicy comment ("no code changes to
// draftGenerator.ts or its runner"), are looked up by `promptRef` rather
// than hardcoded per policy key -- adding a third report type is still just
// one catalog row plus one prompt file.
export const SKILL_NAME = "DraftGenerator";
export const SCHEMA_VERSION = "1.0.0";
export const PROMPT_VERSION = "llm-1";

const MODEL = "claude-opus-4-8";
const MAX_TOKENS = 8000;

// Phase 15 item 1: shown wherever a date/attendees value couldn't be
// determined -- see finalRenderer.ts's existing "Niet vastgelegd" fallback
// for attendees, same convention. Kept as a non-empty string (rather than
// null/empty) so the Phase 14 "Datum niet leeg" structural check
// (reportStructureValidator.ts) keeps working unchanged: a deliberate "not
// recorded" still counts as a present value there. draftQualityPrecheck.ts
// treats this exact string as "absent" for its own, separate correctness
// judgment.
export const DATE_NOT_RECORDED = "Niet vastgelegd";

// Single source of truth for the "Acties en vervolgstappen" heading string --
// draftQualityPrecheck.ts and draftReviser.ts both import this rather than
// each keeping their own copy, so the three can never drift apart on what
// heading they're matching.
export const ACTIONS_SECTION_HEADING = "Acties en vervolgstappen";

// Appended to the report type's own prompt file (same pattern
// draftReviser.ts uses for REVISION_INSTRUCTIONS) rather than edited into
// ai/prompts/reportTypes/{thematic,qa}.md themselves -- this is the one
// analysis those Dutch prompt files leave implicit ("indien van toepassing")
// and that draftQualityPrecheck.ts used to re-derive independently, causing
// the two to disagree. Made explicit and binding here instead: the model
// must answer this exact question once, and `actions_present` is enforced
// deterministically below rather than trusted to make the model's prose
// agree with its own boolean.
export const ACTIONS_PRESENCE_INSTRUCTIONS = `
Bepaal daarnaast expliciet: staan er in de bron (transcript en/of aantekeningen) daadwerkelijk concrete acties, toezeggingen of vervolgstappen die zijn afgesproken (bijvoorbeeld "Jan stuurt het document na" of "we plannen een vervolgafspraak")?

Een algemeen besproken onderwerp, een losse suggestie of een mogelijke vervolgstap ("we kunnen hier later nog naar kijken") is GEEN concrete actie, tenzij de bron duidelijk maakt dat dit daadwerkelijk als vervolgstap is afgesproken. Twijfel je of iets een concrete, afgesproken actie is, beschouw het dan niet als actie.

Zet deze beoordeling in het veld "actions_present" (boolean). Dit veld is bindend voor de sectie "Acties en vervolgstappen (indien van toepassing)" in "sections":
- "actions_present": false -- laat deze sectie volledig weg uit "sections" (geen kop, geen tabel, geen inhoud). Verzin nooit een actie.
- "actions_present": true -- neem de sectie wél op, met de tabel "| Actie | Verantwoordelijke | Deadline | Status |", gevuld met uitsluitend de daadwerkelijk uit de bron gebleken acties. Vul Verantwoordelijke, Deadline en Status uitsluitend in wanneer dit expliciet uit de bron blijkt; laat de cel anders leeg (verzin nooit een verantwoordelijke, deadline of status).
`.trim();

// title/attendees/sections/conversation_date are asked of the model;
// report_type and subject are known facts from the workflow/policy, not
// something an LLM should be reconstructing (matches the "no invented
// facts" framing the prompt files themselves already state). Phase 15: the
// date is no longer supplied by the runner (that was workflow.createdAt --
// the upload/generation moment, not the conversation date, see
// docs/phase-15/README.md item 1) -- the model extracts it from the source
// text itself, only when explicitly present there.
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    attendees: { type: "array", items: { type: "string" } },
    conversation_date: {
      type: ["string", "null"],
      description:
        "De datum van het gesprek zelf, exact zoals vermeld in de brontekst (bijvoorbeeld '12 maart 2026' of '2026-03-12'). Alleen invullen als de brontekst een datum van het gesprek expliciet vermeldt; anders null. Verzin geen datum.",
    },
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
    actions_present: {
      type: "boolean",
      description:
        "Of de brontekst daadwerkelijk concrete, afgesproken acties/vervolgstappen bevat -- zie de aparte instructie hierboven. Bindend voor of 'Acties en vervolgstappen' in sections voorkomt.",
    },
  },
  required: ["title", "attendees", "conversation_date", "sections", "actions_present"],
  additionalProperties: false,
} as const;

interface DraftGeneratorLlmOutput {
  title: string;
  attendees: string[];
  conversation_date: string | null;
  sections: Array<{ heading: string; content: string }>;
  actions_present: boolean;
}

export async function run(params: {
  mergedContent: string;
  policyKey: string;
  promptRef: string;
  subject: string;
  // Phase 18: the explicit context step's active context_items (PvA,
  // normenkader, vragenlijst, ...), kept as a separate labeled block rather
  // than folded into `mergedContent` -- Merger's transcript/notes
  // reconciliation (and ConflictDetector after it) is deliberately untouched
  // by this change, so this reference material never participates in
  // conflict detection, only in drafting the report itself.
  additionalContext?: Array<{ label: string; content: string }>;
}): Promise<DraftGeneratorEnvelope> {
  const { mergedContent, policyKey, promptRef, subject, additionalContext = [] } = params;
  const systemPrompt = `${loadReportTypePrompt(promptRef)}\n\n${ACTIONS_PRESENCE_INSTRUCTIONS}`;

  const contextBlock =
    additionalContext.length > 0
      ? `\n\nAanvullende context (ter referentie, geen letterlijke bron voor citaten):\n\n${additionalContext
          .map((item) => `### ${item.label}\n\n${item.content}`)
          .join("\n\n")}`
      : "";

  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    messages: [
      {
        role: "user",
        content: `Onderwerp: ${subject}\n\nBron (transcript en, indien aanwezig, eigen notities, al samengevoegd):\n\n${mergedContent}${contextBlock}`,
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  const parsed: DraftGeneratorLlmOutput =
    textBlock && textBlock.type === "text"
      ? JSON.parse(textBlock.text)
      : { title: subject, attendees: [], conversation_date: null, sections: [], actions_present: false };

  const date = parsed.conversation_date && parsed.conversation_date.trim().length > 0 ? parsed.conversation_date.trim() : DATE_NOT_RECORDED;

  // Deterministic enforcement, not just a prompt instruction: even if the
  // model's own "actions_present" boolean and its "sections" content
  // disagree with each other, a false "actions_present" always wins -- the
  // section can never survive into the persisted draft when the model itself
  // judged the source has no concrete actions. (The reverse -- forcing the
  // section to appear when actions_present is true -- is deliberately NOT
  // done: that would mean fabricating action content, which is exactly what
  // this is meant to prevent.)
  const sections = parsed.sections.filter(
    (section) => parsed.actions_present || section.heading !== ACTIONS_SECTION_HEADING,
  );

  return {
    skill: SKILL_NAME,
    schema_version: SCHEMA_VERSION,
    // DraftGenerator is a MANDATORY skill (see approval/policyResolver.ts) --
    // confidence is never consulted for routing, so a fixed high value is
    // sufficient rather than asking the model to self-report a score that
    // has no effect either way.
    confidence: 1,
    rationale: `LLM-generated DraftGenerator output (${MODEL}), shaped by the "${policyKey}" report type policy.`,
    flags: [],
    result: {
      report_type: policyKey,
      title: parsed.title,
      attendees: parsed.attendees,
      date,
      subject,
      sections: sections.map((section) => ({ ...section, content: normalizeSectionContent(section.content) })),
      coverage: mergedContent.trim().length > 0 ? 1 : 0,
      actions_present: parsed.actions_present,
    },
  };
}
