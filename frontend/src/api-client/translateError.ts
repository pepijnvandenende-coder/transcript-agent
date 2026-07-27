import { ApiError } from "./client";

// Backend error messages stay English (standing convention since Phase 6 --
// "de codebase blijft Engelstalig") -- this is the frontend-only Dutch
// translation layer, so no English text ever reaches an operator (Phase 11
// feedback item 4). Known message fragments map to an understandable Dutch
// sentence; anything unrecognized (including network failures, which never
// reach the backend at all) falls back to a generic Dutch message rather
// than ever surfacing the raw string.
const GENERIC_FALLBACK = "Er is een fout opgetreden. Probeer het opnieuw.";

const KNOWN_FRAGMENTS: Array<{ fragment: RegExp; dutch: string }> = [
  { fragment: /workflow not found/i, dutch: "Deze workflow bestaat niet (meer)." },
  { fragment: /not available yet/i, dutch: "Nog niet beschikbaar. Probeer het straks opnieuw." },
  { fragment: /no report type suggestion yet/i, dutch: "Er is nog geen voorstel voor het verslagtype." },
  // Phase 12: ConfirmLowConfidenceScreen's confirm/edit-retry actions.
  { fragment: /not at PENDING_HUMAN_CONFIRMATION/i, dutch: "Deze stap is niet meer in behandeling. Ververs de pagina." },
  { fragment: /no open approval request/i, dutch: "Deze stap is niet meer in behandeling. Ververs de pagina." },
  {
    fragment: /reached the maximum of/i,
    dutch: "Je hebt het maximaal aantal pogingen bereikt voor deze stap. Kies bevestigen of annuleer de workflow.",
  },
  { fragment: /does not consume/i, dutch: "Deze stap heeft geen bewerkbare invoer." },
  // Phase 13: report-type deviation, retry-failed-job, and AI-generation
  // failures becoming visible to the operator.
  { fragment: /does not match any active report type policy/i, dutch: "Kies een geldig verslagtype uit de lijst." },
  { fragment: /not at FAILED/i, dutch: "Deze workflow is niet (meer) mislukt; de pagina wordt mogelijk niet meer bijgewerkt weergegeven." },
  { fragment: /has no failed job to retry/i, dutch: "Er is niets om opnieuw te proberen voor deze workflow." },
  {
    fragment: /Missing required environment variable: ANTHROPIC_API_KEY/i,
    dutch: "De AI-koppeling is niet correct ingesteld (ontbrekende sleutel). Neem contact op met de beheerder.",
  },
];

function translateMessage(message: string): string {
  const known = KNOWN_FRAGMENTS.find((entry) => entry.fragment.test(message));
  return known ? known.dutch : GENERIC_FALLBACK;
}

export function translateError(err: unknown): string {
  if (err instanceof ApiError) {
    return translateMessage(err.message);
  }
  return GENERIC_FALLBACK;
}

// Phase 13: jobs.error (see backend/src/jobs/worker.ts's failJob()) is a raw
// JS exception message -- English, sometimes technical -- so it's run
// through the same known-fragment table rather than ever shown verbatim to
// an operator. Unlike translateError(), this takes a plain string (a Job
// row's `error` column, not a caught exception).
export function translateJobError(error: string): string {
  return translateMessage(error);
}
