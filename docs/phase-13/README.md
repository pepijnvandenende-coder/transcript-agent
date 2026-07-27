# Fase 13 — Verbeteringen na eerste echte gebruikstest

## Scope

Vijf verbeteringen op basis van het testen van de workflow met een echt transcript (de sessie die Fase 12 opleverde):

1. `ConfirmLowConfidence` alleen gebruiken wanneer transcript + notities aanwezig zijn en er echte onzekerheid/conflict ontstaat.
2. Transcript-only uploads: alleen AI-validatie uitvoeren, geen zinloze merge-/conflictdetectiestap.
3. `ReportTypeAdvisor`'s heuristiek (vraagtekens tellen) vervangen door een inhoudelijke LLM-classificatie.
4. De gebruiker moet altijd van het AI-advies voor verslagtype kunnen afwijken.
5. Onderzoek + hersteladvies voor het vastlopen van de `DraftGenerator`/Draft-job.

Zoals afgesproken: **dit document is alleen het plan** — er is niets geïmplementeerd.

## Analyse: huidige FSM, states/transities, frontend routes, backend routing

### FSM (`backend/src/workflow/transitions.ts`, `states.ts`)

De relevante keten is (ingekort):

```
TRANSCRIPT_UPLOADED --submit_for_validation--> VALIDATING_TRANSCRIPT
  --transcript_validation.auto_approved--> MERGING
  --transcript_validation.low_confidence/.schema_invalid--> PENDING_HUMAN_CONFIRMATION

MERGING
  --merge.auto_approved--> DETECTING_CONFLICTS
  --merge.low_confidence/.schema_invalid--> PENDING_HUMAN_CONFIRMATION

DETECTING_CONFLICTS
  --conflict_detection.conflicts_found--> CONFLICTS_PENDING_REVIEW
  --conflict_detection.none_found_auto_approved--> SUGGESTING_REPORT_TYPE
  --conflict_detection.none_found_low_confidence/.schema_invalid--> PENDING_HUMAN_CONFIRMATION

SUGGESTING_REPORT_TYPE --report_type_suggested--> AWAITING_REPORT_TYPE_SELECTION
AWAITING_REPORT_TYPE_SELECTION --select_report_type--> GENERATING_DRAFT
GENERATING_DRAFT --draft_generated--> DRAFT_QUALITY_PRECHECK --precheck_completed--> DRAFT_PENDING_REVIEW
```

Notities zijn **altijd optioneel** geweest, al sinds Fase 2: `POST /workflows/:id/notes` staat los van `submit_for_validation`, en niets in de FSM controleert of er notities zijn vóór `MERGING` wordt binnengegaan.

### De kernoorzaak van eis 1 en 2

`backend/src/ai/skills/merger.ts:12-13`:

```ts
const WITH_NOTES_CONFIDENCE = 0.92;
const WITHOUT_NOTES_CONFIDENCE = 0.65;
```

met `approval_policies` voor `Merger`: `AUTO_IF_ABOVE` @ 0.80 (`backend/prisma/seed.ts:20-28`). Zonder notities is `0.65 < 0.80` **altijd** waar — dus elke transcript-only workflow eindigt gegarandeerd bij `PENDING_HUMAN_CONFIRMATION`, ongeacht de inhoud. Dit is geen inhoudelijke onzekerheid: het eigen commentaar bij deze stub (`docs/phase-3/README.md` regel 51) zegt het met zoveel woorden — de waarde 0.65 is gekozen zodat **tijdens Fase 3 het low-confidence-pad testbaar was**, niet omdat "geen notities" een echte reden voor twijfel is. Dat is precies wat er in de praktijktest fout liep.

`ConflictDetector` (`backend/src/ai/skills/conflictDetector.ts`) is dat niet: confidence ligt vast op 0.9 (ruim boven zijn drempel van 0.7) en conflicten worden alleen afgeleid uit `Merger`'s `unmatched_notes`, die zonder notities altijd leeg is. Zonder notities veroorzaakt `ConflictDetector` dus nooit een checkpoint — het voert alleen een **zinloze AI-aanroep** uit (conflicten zoeken tussen een document en zichzelf), wat eis 2 wél raakt (kosten/onduidelijkheid), maar niet eis 1.

### Frontend routes (`frontend/src/routes/WorkflowPage.tsx`, `state/useWorkflow.ts`)

`WorkflowPage`'s `SCREENS`-tabel dispatcht puur op `workflow.currentState`; er is geen aparte route per stap. `MERGING`/`DETECTING_CONFLICTS`/`GENERATING_DRAFT` zijn "transient states" (`useWorkflow.ts:12-21`): de UI toont alleen de `StatusBadge` en, na 10 seconden, de hint "Draait de worker?" — geen concept van voortgang of falen totdat de state daadwerkelijk verandert.

### Backend routing or ontbrekend stuk: geen herstelpad na `FAILED`

`workflow/transitions.ts:166-169` genereert voor elke `PROCESSING`-state een `job_failed.<state>` (→ `FAILED`) én een `retry_failed_job.<state>` (`FAILED` → terug naar die state) — dit bestaat dus al in de FSM. Maar:

```
grep "retry-failed-job|retry_failed_job" backend/src/api/**/*.ts   → 0 treffers
```

**Er is geen enkele API-route die deze transitie ooit aanroept.** Zodra een job faalt — om welke reden dan ook — komt de workflow blijvend vast te zitten op `FAILED`. `WorkflowPage.tsx` toont dan alleen "Deze workflow is mislukt." zonder enige herstelactie (geen retry-knop, en `BackOrCancel` wordt hier niet gerenderd omdat `FAILED` als terminale state buiten de `Screen`/`NOT_BUILT_STATES`-paden valt). Dit is direct relevant voor eis 5.

## Eis 1 + 2: ConfirmLowConfidence alleen bij echte onzekerheid, transcript-only alleen valideren

### Aanbevolen aanpak

**Geen nieuwe FSM-states of -transities.** De workflow doorloopt `MERGING` en `DETECTING_CONFLICTS` nog steeds als states (consistent met het bestaande principe "elke stap is een echte, auditeerbare state"), maar zonder notities wordt in beide runners de AI-aanroep zelf overgeslagen:

- **`backend/src/jobs/runners/mergeRunner.ts`**: kent `note` (via het al bestaande `findLatestNote()`) al vóórdat `merger.run()` wordt aangeroepen. Voeg aan `MergerResultSchema` een veld `notes_provided: boolean` toe, gezet door `merger.run()` op basis van zijn eigen `hasNotes`-berekening (die al bestaat, regel 16). Voeg in `backend/src/approval/policyResolver.ts`'s `SEMANTIC_HOOKS` een `Merger`-hook toe, naar exact hetzelfde patroon als de bestaande hooks voor `TranscriptQualityChecker` en `ConflictDetector`:

  ```ts
  Merger: (result) => (result.notes_provided === false ? "auto_approved" : null),
  ```

  Dit maakt het low-confidence-pad voor `Merger` **structureel onbereikbaar zonder notities** — geen speciale casus in `gateway.ts`, geen nieuw event, hergebruik van het bestaande semantic-hook-mechanisme. Mét notities blijft `Merger`'s echte confidence-drempel (0.80) gewoon van kracht, dus `PENDING_HUMAN_CONFIRMATION` blijft bereikbaar wanneer het samenvoegen van twee bronnen daadwerkelijk onzeker is — precies wat eis 1 vraagt.

- **`backend/src/jobs/runners/conflictDetectionRunner.ts`**: als de laatst geschreven `merges`-rij geen sectie met `source: "notes"` bevat (dus: transcript-only), sla de aanroep naar `ai/skills/conflictDetector.ts` over. Schrijf direct een leeg conflictresultaat weg en routeer via dezelfde `bypassEvent`-achtige auto-approve-route die `gateway.ts` al voor `DraftQualityPrecheck`/`FinalRenderer` gebruikt (regel 387-407) — dit vereist een klein, gericht `SKILL_ROUTING`-aanpassing voor `ConflictDetector`, niet een generieke herstructurering.

**Resultaat**: bij een transcript-only upload wordt `TranscriptQualityChecker` de **enige** echte AI-aanroep tot aan de verslagtype-suggestie — dat is de inhoudelijke betekenis van "alleen AI-validatie uitvoeren" (eis 2), ook al blijft de workflow voor auditeerbaarheid nog via `MERGING`/`DETECTING_CONFLICTS` lopen. `PENDING_HUMAN_CONFIRMATION` wordt daarmee uitsluitend bereikt via een merge/conflict-stap die notities daadwerkelijk verwerkte (eis 1). `TranscriptQualityChecker`'s eigen low-confidence-pad (transcriptkwaliteit zelf) blijft ongewijzigd — dat is een aparte, terechte vorm van onzekerheid, los van notities.

### Overwogen alternatief (afgewezen)

Een nieuwe FSM-transitie `transcript_validation.auto_approved_no_notes` die `VALIDATING_TRANSCRIPT` direct naar `SUGGESTING_REPORT_TYPE` laat springen (states `MERGING`/`DETECTING_CONFLICTS` volledig overslaan). Dit is de letterlijkste lezing van "alleen AI-validatie", maar vereist: een nieuw system-event, een nieuwe transitieregel, een synthetische `merges`-rij die buiten de normale `Merger`-flow om geschreven moet worden, en een aanpassing van hoe `TranscriptQualityChecker`'s routing beslist tussen twee "auto_approved"-events. Groter, risicovoller diff voor hetzelfde eindresultaat (geen onnodige AI-aanroepen, geen onterecht checkpoint). Aanbeveling: alleen kiezen als er straks een harde eis komt dat transcript-only workflows de states `MERGING`/`DETECTING_CONFLICTS` nooit mogen *bezoeken* (bijv. voor rapportagedoeleinden) — vraag dit expliciet na bij de gebruiker als dat toch belangrijk blijkt.

## Eis 3: ReportTypeAdvisor — echte LLM-classificatie in plaats van heuristiek

### Huidige situatie

`backend/src/ai/skills/reportTypeAdvisor.ts` is nog een Fase 6-stub: `looksLikeQA = mergedContent.includes("?")`. Dat is de heuristiek die in de praktijktest ook zichtbaar werd ("Er zijn geen vraagtekens gevonden...").

### Aanpak — zelfde patroon als DraftGenerator (Fase 11)

`DraftGenerator` (`backend/src/ai/skills/draftGenerator.ts`) is al omgebouwd naar een echte Anthropic-aanroep via `backend/src/ai/anthropicClient.ts` en `output_config.format` (structured outputs) met een JSON-schema. `ReportTypeAdvisor` volgt exact dit patroon:

- Nieuw promptbestand `backend/src/ai/prompts/reportTypeClassifier.md` (Nederlandstalig, net als `reportTypes/thematic.md`/`qa.md`): legt uit wat de AI moet doen — de samengevoegde inhoud beoordelen en het meest passende verslagtype kiezen uit de aangeleverde catalogus (sleutel + weergavenaam + korte kenmerken per type), met een korte, Nederlandse motivatie.
- `reportTypeAdvisor.run()` wordt `async`, laadt de prompt, roept `getAnthropicClient().messages.create()` aan met `output_config: { format: { type: "json_schema", schema: {...} } }` voor `{ suggested_type: string, rationale: string, runner_up: string }`, waarbij `suggested_type`/`runner_up` beperkt worden tot de daadwerkelijk aangeleverde actieve catalogussleutels (geen vrije tekst).
- `runSuggestReportTypeJob` (`suggestReportTypeRunner.ts`) blijft verantwoordelijk voor het ophalen van de catalogus (`findActivePolicies()`, al aanwezig) en geeft die — in plaats van alleen de twee hardcoded labels `thematicLabel`/`qaLabel` — als volledige lijst door aan de skill, zodat een derde verslagtype later zonder codewijziging aan de classificatie meedoet (dezelfde belofte als het bestaande `ReportTypePolicy`-commentaar al voor de generatie-kant doet).
- `PROMPT_VERSION` wordt `"llm-1"` (zelfde naamgeving als `DraftGenerator`).

**Modelkeuze**: nog te bevestigen. Voor nieuwe LLM-aanroepen is `claude-opus-5` het uitgangspunt, tenzij er reden is om aan te sluiten bij `DraftGenerator`'s huidige `claude-opus-4-8` voor consistentie binnen dezelfde codebase, of om voor deze relatief eenvoudige classificatietaak een goedkoper model te overwegen. Dit leggen we aan jou voor tijdens implementatie — geen aanname vooraf.

## Eis 4: gebruiker moet altijd kunnen afwijken van het AI-advies

### Belangrijk: dit draait een eerdere, bewuste keuze terug

`ReportTypeSelectionScreen.tsx:14-18` bevat een expliciete Fase-11-beslissing: *"the user must not be able to freely pick a different report type... the earlier 'ander verslagtype' free-text fallback and the separate runner-up button are removed entirely."* Eis 4 keert dit om. Dat is geen probleem — de **backend** heeft deze beperking nooit gehad: `selectReportType()` (`backend/src/approval/reportTypeSelection.ts:43-45`) accepteert al elke geldige sleutel of weergavenaam uit `report_type_policies`, niet alleen de gesuggereerde. De beperking zit uitsluitend in de frontend.

### Aanpak

- **Backend**: één nieuwe, lichte route, bijvoorbeeld `GET /report-type-policies` (niet workflow-scoped, want de catalogus is dat ook niet), die `findActivePolicies()` (bestaat al, ongebruikt) teruggeeft: `{ key, displayName }[]`.
- **Frontend**: `client.ts` krijgt `getReportTypePolicies()`. `ReportTypeSelectionScreen.tsx` toont naast het AI-voorstel (met motivatie, zoals nu) een keuzelijst van alle actieve verslagtypen, voorgeselecteerd op de suggestie. De knop "Akkoord" wordt vervangen door een submit die altijd het **daadwerkelijk geselecteerde** type verstuurt (dus ook wanneer dat gelijk is aan de suggestie) — geen apart "wijken af"-pad nodig, gewoon één submit-actie met een echte keuze eronder. `BackOrCancel` blijft ongewijzigd.
- Geen wijziging nodig aan `POST /workflows/:id/report-type` of `selectReportType()` — die accepteren dit al.

## Eis 5: onderzoek DraftGenerator/Draft-job die blijft hangen

Geen implementatie hier — wel de bevindingen uit codeonderzoek, ter voorbereiding op de daadwerkelijke fix in Fase 13's implementatiefase.

### Bevinding A — `ANTHROPIC_API_KEY` ontbreekt en is niet gedocumenteerd

```
backend/.env          → geen ANTHROPIC_API_KEY
backend/.env.example  → noemt ANTHROPIC_API_KEY nergens
```

`ai/anthropicClient.ts` gooit synchroon `Missing required environment variable: ANTHROPIC_API_KEY` zodra `DraftGenerator` voor het eerst een echte aanroep probeert te doen (Fase 11-wijziging: `DraftGenerator` gebruikt sinds die fase de echte Anthropic API, niet meer de stub). Deze fout wordt keurig opgevangen door `jobs/worker.ts`'s `processNextJob()` en resulteert in `job_failed.GENERATING_DRAFT` → state `FAILED` — dus **geen oneindige hang in de job zelf**, wél een informatieloze doodlopende weg (zie Bevinding C).

### Bevinding B — de worker-daemon heeft geen supervisor/herstart

`backend/src/jobs/workerMain.ts:10-13`: als `runPollingLoop()` een onverwachte (niet door `processNextJob`'s eigen `try/catch` opgevangen) fout gooit — bijvoorbeeld een fout in `claimNextQueuedJob()` zelf, een tijdelijk verbroken databaseverbinding, of een ongevangen promise-afwijzing ergens in een runner — wordt dit gelogd en volgt `process.exit(1)`. `npm run worker` draait via `tsx watch`, dat **alleen herstart bij bestandswijzigingen, niet bij een procescrash**. Als dit gebeurt, blijven alle toekomstige jobs (van elk type, niet alleen `GENERATE_DRAFT`) voor altijd op `QUEUED` staan — dit is een **letterlijke, oneindige hang**, exact wat er gerapporteerd is. Dit is op dit moment de meest waarschijnlijke verklaring, omdat het scenario "wordt gegenereerd..." zonder ooit een foutmelding te tonen het beste past bij een gestopte worker, niet bij een job die na een paar seconden faalt.

### Bevinding C — geen herstelpad na `FAILED` (zie ook de FSM-analyse hierboven)

Zelfs als de job wél netjes faalt (bijv. door de ontbrekende API-key), komt de workflow vast te zitten op `FAILED` zonder enige knop om opnieuw te proberen — de FSM-transitie `retry_failed_job.<state>` bestaat, maar er is geen route die hem blootlegt. Voor de operator voelt "faalt direct, geen herstelpad" hetzelfde aan als "blijft hangen".

### Hersteladvies voor Fase 13 (te implementeren, niet nu)

1. `ANTHROPIC_API_KEY` toevoegen aan `.env.example` met uitleg wanneer het nodig is (zodra `DraftGenerator`/de nieuwe `ReportTypeAdvisor`-classificatie draait), en de bestaande foutmelding een Nederlandse vertaalregel geven in `translateError.ts` zodra dit ooit richting de operator-UI lekt.
2. Een expliciete `POST /workflows/:id/actions/retry-failed-job` route toevoegen die de al bestaande `retry_failed_job.<state>`-transitie aanroept, plus een frontend-scherm/knop voor de `FAILED`-state (in plaats van de huidige kale "mislukt"-melding zonder vervolg).
3. Documenteren (en overwegen te automatiseren, bijv. via een `pm2`/`systemd`-voorbeeld of een simpele "worker health"-indicator in de UI) dat `npm run worker` een losstaand, altijd-draaiend proces is dat niet vanzelf herstart na een crash — dit is precies waarom `WorkflowPage.tsx` al de hint "Draait de worker?" toont, maar die hint verschijnt pas na 10 seconden wachten en geeft geen definitief antwoord.
4. Overwegen om `getAnthropicClient()`/de aanroepen zelf een expliciete, kortere timeout te geven (nu de SDK-default van 10 minuten) zodat een netwerkprobleem sneller zichtbaar faalt in plaats van lang stil te hangen.

## Overzicht van backend-wijzigingen

| Bestand | Wijziging |
|---|---|
| `backend/src/ai/skillEnvelope.ts` | `MergerResultSchema` + `notes_provided: boolean` |
| `backend/src/ai/skills/merger.ts` | `result.notes_provided` zetten op basis van bestaande `hasNotes` |
| `backend/src/approval/policyResolver.ts` | `SEMANTIC_HOOKS.Merger` toevoegen (notes_provided === false → `auto_approved`) |
| `backend/src/jobs/runners/conflictDetectionRunner.ts` | Sla `conflictDetector.run()` over wanneer de merge geen notities-sectie bevat; auto-approve deterministisch |
| `backend/src/approval/gateway.ts` | Kleine `SKILL_ROUTING`-aanpassing voor `ConflictDetector`'s notities-loze bypass-pad |
| `backend/src/ai/skills/reportTypeAdvisor.ts` | Vervangen door echte LLM-aanroep (async), `PROMPT_VERSION` → `"llm-1"` |
| `backend/src/ai/prompts/reportTypeClassifier.md` (nieuw) | Nederlands classificatie-prompt |
| `backend/src/jobs/runners/suggestReportTypeRunner.ts` | Geeft volledige actieve catalogus door i.p.v. twee hardcoded labels |
| `backend/src/api/reportType.routes.ts` | + `GET /report-type-policies` |
| `backend/.env.example` | + `ANTHROPIC_API_KEY` gedocumenteerd |
| `backend/src/api/*.routes.ts` | (Fase 13-vervolg, zie eis 5) + `POST /workflows/:id/actions/retry-failed-job` |

## Overzicht van frontend-wijzigingen

| Bestand | Wijziging |
|---|---|
| `frontend/src/api-client/client.ts` | + `getReportTypePolicies()` |
| `frontend/src/routes/ReportTypeSelection/ReportTypeSelectionScreen.tsx` | Keuzelijst i.p.v. enkel "Akkoord"; submit stuurt altijd het geselecteerde type |
| `frontend/src/routes/WorkflowPage.tsx` | (Fase 13-vervolg, zie eis 5) scherm/actie voor `FAILED` |

Geen wijziging nodig aan `ConfirmLowConfidenceScreen.tsx` zelf (Fase 12) — dat scherm blijft correct werken; het wordt door de eis 1/2-wijziging alleen minder vaak (en terechter) getoond.

## Teststrategie

- `backend/tests/approval/policyResolver.test.ts`: nieuw geval voor de `Merger`-hook (notes_provided false/true).
- `backend/tests/ai/merger.test.ts`: `notes_provided` in het envelope-resultaat.
- `backend/tests/jobs/worker.test.ts` of een nieuwe `conflictDetectionRunner`-test: transcript-only merge slaat de `ConflictDetector`-aanroep over en auto-approvet.
- `backend/tests/api/approvalRequest.routes.test.ts` / een nieuwe end-to-end test: transcript-only workflow (geen notities) doorloopt `VALIDATING_TRANSCRIPT → MERGING → DETECTING_CONFLICTS → SUGGESTING_REPORT_TYPE` **zonder** ooit `PENDING_HUMAN_CONFIRMATION` te raken.
- `backend/tests/ai/reportTypeAdvisor.test.ts`: aangepast voor de nieuwe async/LLM-vorm, met een gemockte `anthropicClient` (zelfde patroon als `draftGenerator.test.ts` al gebruikt voor `DraftGenerator`).
- `frontend/src/routes/ReportTypeSelection/ReportTypeSelectionScreen.test.tsx`: keuzelijst toont alle actieve typen, voorgeselecteerd op de suggestie; submit met een afwijkende keuze stuurt dat type door.
- Voor eis 5: geen nieuwe tests deze fase (onderzoek/plan), wel testdekking zodra de fix (retry-route + scherm) wordt geïmplementeerd.

## Openstaande vragen voor jou

1. **Modelkeuze voor de nieuwe `ReportTypeAdvisor`-classificatie** (eis 3): `claude-opus-5` (het huidige uitgangspunt), aansluiten bij `DraftGenerator`'s `claude-opus-4-8`, of een goedkoper model gezien de eenvoud van de taak?
2. **Scope van eis 1/2**: is de aanbevolen aanpak (states blijven bestaan, AI-aanroepen worden overgeslagen) voldoende, of is het echt vereist dat `MERGING`/`DETECTING_CONFLICTS` als states volledig worden overgeslagen bij transcript-only uploads?
3. **Eis 5**: bevestig je de twee hersteladviezen (retry-route + herstelscherm voor `FAILED`, en het documenteren/zichtbaar maken van de worker-status) als scope voor de implementatie, of wil je dit verder inperken?
