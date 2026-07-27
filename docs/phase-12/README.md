# Fase 12 — ConfirmLowConfidence-scherm

## Scope

Bouwt het scherm voor `WorkflowState.PENDING_HUMAN_CONFIRMATION`, het generieke checkpoint dat sinds Fase 1 in de FSM bestaat maar tot nu toe geen frontend heeft (`frontend/src/routes/WorkflowPage.tsx:29-31,52-54` noemt het letterlijk bij naam als het ontbrekende scherm). De operator test de workflow met een echt transcript en loopt hier vast — dit is verwacht gedrag, geen bug.

Het scherm moet (eis vanuit dit verzoek):

1. volledig Nederlands zijn;
2. uitleggen waarom menselijke bevestiging nodig is;
3. tonen welke onzekerheid de AI heeft;
4. drie keuzes bieden: **(1) bevestigen en doorgaan**, **(2) teruggaan en transcript/notities aanpassen**, **(3) workflow annuleren**.

## Bevindingen: wat er al bestaat

**FSM (`backend/src/workflow/transitions.ts:37-119`, `states.ts`)** — volledig aanwezig, geen wijziging nodig:

- `PENDING_HUMAN_CONFIRMATION` is één herbruikbaar checkpoint, bereikbaar vanuit drie "origin"-stappen:
  | Origin-skill | Aankomst-events | `confirm.*` gaat naar | `retry.*`/`edit_retry.*` gaat terug naar |
  |---|---|---|---|
  | `TranscriptQualityChecker` | `transcript_validation.low_confidence`, `.schema_invalid` | `MERGING` | `VALIDATING_TRANSCRIPT` |
  | `Merger` | `merge.low_confidence`, `.schema_invalid` | `DETECTING_CONFLICTS` | `MERGING` |
  | `ConflictDetector` | `conflict_detection.none_found_low_confidence`, `.schema_invalid` | `SUGGESTING_REPORT_TYPE` | `DETECTING_CONFLICTS` |
- De user-actions `confirm.<step>` / `retry.<step>` / `edit_retry.<step>` bestaan al voor alle drie.

**Backend endpoints (`backend/src/api/approvalRequest.routes.ts`)** — bestaan al, volledig werkend, met eigen testdekking (`backend/tests/api/approvalRequest.routes.test.ts`):

- `GET /workflows/:id/approval-request` — het open `ApprovalRequest`-record.
- `POST /workflows/:id/approval-request/confirm` — `{ actorId }`.
- `POST /workflows/:id/approval-request/retry` — `{ actorId, reviewerComment? }` (opnieuw proberen zonder wijziging).
- `POST /workflows/:id/approval-request/edit-retry` — `{ actorId, transcriptContent?, notesContent?, reviewerComment? }`.

Al deze routes lopen via `backend/src/approval/gateway.ts`'s `confirmApprovalRequest`/`retryApprovalRequest`/`editRetryApprovalRequest`, die alle FSM-preconditie-checks, retry-budget-bewaking en input-validatie al afhandelen. **Er is geen nieuwe backend-actie-logica nodig.**

**Onzekerheidsdata (`backend/src/approval/confidenceScorer.ts`, `prisma/schema.prisma` model `AiOutput`)** — al berekend en opgeslagen, maar niet exposed op de plek waar dit scherm het nodig heeft:

- `confidenceScore` / `confidenceBreakdown` (`{ llmSelfReported, structuralScore, confidence }`) worden gezet zodra de skill-output schema-geldig is; blijven `null` bij een schema-ongeldige output.
- `validationStatus` (`VALID`/`INVALID`) en `validationErrors` dekken het schema-ongeldige geval.
- De drempelwaarde (`AUTO_IF_ABOVE`) staat per skill in `approval_policies.confidenceThreshold`, opgelost in `backend/src/approval/policyResolver.ts`.
- **Gat**: `GET /workflows/:id/approval-request` retourneert alleen het kale `ApprovalRequest`-record (`aiOutputId`, `intendedNextState`, `attemptCount`, `status`, ...) — geen genest `aiOutput` met `skillName`/`confidenceScore`/`confidenceBreakdown`/`validationStatus`/`validationErrors`. Zonder die velden kan het scherm eis 2 en 3 niet vervullen.

**Frontend (`frontend/src/api-client/client.ts`, `translateError.ts`)** — nul dekking voor dit endpoint-gezin:

- Geen enkele `client.ts`-functie voor `/approval-request*` (bevestigd: geen match op "approval").
- `translateError.ts`'s `KNOWN_FRAGMENTS` (regel 12-16) heeft geen vertaling voor de foutmeldingen die deze acties kunnen teruggeven: `NotAtCheckpointError`, `NoOpenApprovalRequestError`, `MaxRetriesExceededError` (409), `InvalidRetryInputError` (400). Zonder vertaling valt dit scherm terug op de generieke Nederlandse foutmelding, wat voor "maximaal aantal pogingen bereikt" minder duidelijk is dan een specifieke tekst.

**Belangrijk randgeval — niet elke origin-skill is editable**: `editRetryApprovalRequest` (`gateway.ts:588-593`) valideert het aangeboden inputtype tegen `SkillRouting.inputs`:

- `TranscriptQualityChecker` → alleen `transcriptContent` toegestaan.
- `Merger` → zowel `transcriptContent` als `notesContent` toegestaan.
- `ConflictDetector` → `inputs: []` → **elke edit-retry wordt afgewezen** (400 `InvalidRetryInputError`), want er is voor deze stap niets bewerkbaars.

Optie 2 uit de eis ("teruggaan en transcript/notities aanpassen") is dus **niet universeel beschikbaar** — het scherm moet per origin-skill weten welke velden (indien aanwezig) getoond mogen worden, en voor `ConflictDetector` die optie geheel weglaten in plaats van een backend-fout op te wachten.

## Benodigde backend-aanpassing

Één kleine, additieve wijziging — **geen Prisma-migratie, geen FSM-wijziging**:

Verrijk `GET /workflows/:id/approval-request` (`backend/src/api/approvalRequest.routes.ts:12-28`) met de gekoppelde `AiOutput`-gegevens en de retry-limiet, zodat de frontend in één call alles heeft om eis 2 en 3 te vervullen:

```
{
  id, workflowId, aiOutputId, intendedNextState, attemptCount, status, resolution, createdAt, resolvedAt,
  aiOutput: {
    skillName, validationStatus, validationErrors,
    confidenceScore, confidenceBreakdown, attemptNumber
  },
  maxRetries   // uit approval_policies, via policyResolver.ts's al bestaande getMaxRetries()
}
```

Implementatie: `findAiOutputById()` (bestaat al in `aiOutputRepository.ts`, wordt al gebruikt door `gateway.ts`) en `getMaxRetries()` (bestaat al in `policyResolver.ts`) aanroepen in de route-handler en samenvoegen in de response. Geen nieuwe repository-functies, geen schema-wijziging.

Confirm/retry/edit-retry endpoints zelf blijven ongewijzigd.

## Frontend-ontwerp

Volgt exact het patroon van `DraftReviewScreen`/`ConflictReviewScreen`: fetch-on-mount, laad-/foutstatus, actieknoppen met eigen submit-status, `onUpdated(workflow)` bij succes, `BackOrCancel` voor de annuleer-actie.

### Nieuwe/gewijzigde modules

| Pad | Wijziging |
|---|---|
| `frontend/src/api-client/client.ts` | + type `ApprovalRequest` (incl. genest `aiOutput`), + `getApprovalRequest(workflowId)`, `confirmApprovalRequestAction(workflowId, { actorId })`, `editRetryApprovalRequestAction(workflowId, { actorId, transcriptContent?, notesContent? })`. Geen `retry`-functie (zie "Buiten scope"). |
| `frontend/src/api-client/translateError.ts` | + 4 `KNOWN_FRAGMENTS`: "not at PENDING_HUMAN_CONFIRMATION" → "Deze stap is niet meer in behandeling; de pagina wordt mogelijk niet meer bijgewerkt weergegeven.", "no open approval request" → vergelijkbaar, "reached the maximum of" → "Je hebt het maximaal aantal pogingen bereikt voor deze stap. Kies bevestigen of annuleer de workflow.", "does not consume" → "Deze stap heeft geen bewerkbare invoer." (laatste is een verdedigingslaag; de UI voorkomt dit al door optie 2 conditioneel te tonen). |
| `frontend/src/routes/ConfirmLowConfidence/ConfirmLowConfidenceScreen.tsx` (nieuw) | Het scherm zelf, zie hieronder. |
| `frontend/src/routes/ConfirmLowConfidence/ConfirmLowConfidenceScreen.test.tsx` (nieuw) | Zie teststrategie. |
| `frontend/src/routes/WorkflowPage.tsx` | `SCREENS["PENDING_HUMAN_CONFIRMATION"] = ConfirmLowConfidenceScreen`; verwijder `"PENDING_HUMAN_CONFIRMATION"` uit `NOT_BUILT_STATES` (regel 31) — `TRANSCRIPT_INSUFFICIENT` blijft staan, die valt buiten deze fase. |
| `frontend/src/routes/WorkflowPage.test.tsx` | De `it.each(["PENDING_HUMAN_CONFIRMATION", "TRANSCRIPT_INSUFFICIENT"])`-test (regel 86-93) splitst: `PENDING_HUMAN_CONFIRMATION` verhuist naar een nieuwe dispatch-test (met gestubte `ConfirmLowConfidenceScreen`, zelfde patroon als de andere stubs regel 12-18); `TRANSCRIPT_INSUFFICIENT` blijft in de "nog niet gebouwd"-test staan. |

Geen routing-wijziging nodig — `WorkflowPage` dispatcht al puur op `workflow.currentState`, er is geen per-state URL.

### Schermopbouw (Nederlandse copy)

```
┌─────────────────────────────────────────────────────────────┐
│ Bevestiging nodig                                            │
│                                                                │
│ <uitleg, afhankelijk van origin-skill + validationStatus>    │
│                                                                │
│ <onzekerheid: confidence-percentage of "kon niet worden       │
│   gecontroleerd" bij schema-ongeldige output>                │
│                                                                │
│ Poging {attemptCount} van maximaal {maxRetries}.              │
│                                                                │
│ [Bevestigen en doorgaan]                                      │
│                                                                │
│ ── alleen als de origin-skill bewerkbare invoer heeft ──      │
│ [transcript-tekstveld]  (transcript_validation, merge)        │
│ [notities-tekstveld]    (alleen merge)                        │
│ [Aangepaste versie opnieuw laten controleren]                 │
│                                                                │
│ <BackOrCancel mode="cancel">                                  │
│ [Workflow annuleren]                                          │
└─────────────────────────────────────────────────────────────┘
```

**Uitlegregel per origin-skill** (analoog aan `DraftReviewScreen.tsx`'s `precheckMessage()`-patroon — een pure functie `explanationFor(skillName, validationStatus)` die Engelse backend-namen naar een Nederlandse zin vertaalt):

- `TranscriptQualityChecker` + `VALID`: "De AI is onvoldoende zeker of het transcript geschikt is om mee door te gaan."
- `Merger` + `VALID`: "De AI is onvoldoende zeker over het automatisch samenvoegen van transcript en notities."
- `ConflictDetector` + `VALID`: "De AI is onvoldoende zeker of er tegenstrijdigheden in het samengevoegde materiaal zitten."
- Elke skill + `INVALID`: "De AI kon voor deze stap geen bruikbaar resultaat opleveren." — **`validationErrors` (zod-issues) worden niet rauw getoond**: dat zijn Engelse, ontwikkelaarsgerichte paden/codes, niet geschikt voor een "volledig Nederlands" scherm. Alleen de generieke zin; technische details blijven voor logs/devtools. (Expliciete scope-keuze, geen achterstallige taak.)

**Onzekerheidsregel**: bij `VALID` tonen als percentage: `Zekerheid van de AI: {Math.round(confidenceScore * 100)}%`. Bij `INVALID` (confidenceScore is dan `null`): "De AI-uitvoer kon niet op zekerheid worden beoordeeld — het formaat klopte niet."

**Optie 2 conditioneel per skill** (afgeleid van de al bekende `SkillRouting.inputs`-tabel hierboven, hard gecodeerd in de frontend als eenvoudige `Record<string, Array<"transcript" | "notes">>` omdat dit dezelfde vaste mapping is als `gateway.ts`'s `SKILL_ROUTING`):

- `TranscriptQualityChecker` → alleen transcript-veld.
- `Merger` → transcript- én notities-veld.
- `ConflictDetector` → geen veld, geen knop; in plaats daarvan een korte regel: "Voor deze stap is er niets om aan te passen — kies bevestigen of annuleer de workflow."

**Retry-budget**: als `attemptCount >= maxRetries`, optie 2 uitschakelen (of vervangen door dezelfde toelichtingsregel als hierboven) in plaats van te wachten op de 409 van de backend.

**Optie 3**: `<BackOrCancel mode="cancel" workflowId={workflow.id} currentUserId={currentUserId} onCancelled={onUpdated} />`, ongewijzigd hergebruikt — geeft al een Nederlandse inline bevestigingsstap in plaats van een blokkerende `window.confirm`.

## Buiten scope

- **De losse `retry`-actie (optie "opnieuw proberen zonder wijziging")** — bestaat al backend-side, maar de eis noemt precies drie keuzes (bevestigen / aanpassen-en-opnieuw / annuleren). Geen vierde knop deze fase; kan later één `client.ts`-functie + één knop zijn zonder verdere backend-werk.
- **Rauwe weergave van `validationErrors`** (zie hierboven) — bewust weggelaten voor de Nederlandstalige, operator-gerichte lezing.
- **Wijzigingen aan `workflow/transitions.ts`, `workflow/states.ts`, of `approval/gateway.ts`'s actie-functies** — niets hiervan hoeft te veranderen.
- **`TRANSCRIPT_INSUFFICIENT`-scherm** — blijft een apart, nog niet gebouwd scherm; niet onderdeel van deze fase.
- **Real-time updates tijdens het bewerken** (bijv. waarschuwen als een ander tabblad de workflow intussen al heeft bevestigd) — bestaande polling via `useWorkflow` volstaat, zelfde aanpak als de andere schermen.

## Teststrategie

- **Backend**: `backend/tests/api/approvalRequest.routes.test.ts` uitbreiden met een assertie dat `GET .../approval-request` nu een genest `aiOutput` (`skillName`, `validationStatus`, `confidenceScore`, `confidenceBreakdown`) en `maxRetries` teruggeeft — geen nieuwe testfile nodig, confirm/retry/edit-retry-paden hebben al dekking.
- **Frontend `ConfirmLowConfidenceScreen.test.tsx`** (nieuw, patroon van `DraftReviewScreen.test.tsx`: mock `../../api-client/client`):
  - laadstatus en foutstatus (via `translateError`);
  - juiste Nederlandse uitleg per combinatie van `skillName` × `validationStatus` (tabel-gedreven `it.each`);
  - toont het confidence-percentage correct afgerond; toont de alternatieve tekst bij `INVALID`;
  - toont transcript-veld voor `TranscriptQualityChecker`, transcript+notities voor `Merger`, geen veld (en de toelichtingsregel) voor `ConflictDetector`;
  - "Bevestigen en doorgaan" roept `confirmApprovalRequestAction` aan en geeft `onUpdated` door bij succes;
  - het bewerkingsformulier roept `editRetryApprovalRequestAction` aan met alleen de ingevulde velden;
  - optie 2 is uitgeschakeld/verborgen zodra `attemptCount >= maxRetries`;
  - annuleren gebeurt via `BackOrCancel` (zelfde assertie-stijl als `DraftReviewScreen.test.tsx`'s cancel-test).
- **`WorkflowPage.test.tsx`**: dispatch-test voor `PENDING_HUMAN_CONFIRMATION` → `ConfirmLowConfidenceScreenStub` (gestubd zoals de andere schermen); de "nog niet gebouwd"-test dekt voortaan alleen nog `TRANSCRIPT_INSUFFICIENT`.

## Locked decision

Drie keuzes, niet vier: de losse "opnieuw proberen zonder wijziging"-actie blijft bewust buiten de UI van dit scherm (zie "Buiten scope"). Bevestigd — geen vierde knop, ook niet in een latere fase van dit scherm.
