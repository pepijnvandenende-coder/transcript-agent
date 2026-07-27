# Fase 15 — UX en outputverbeteringen

## Scope

Vier losstaande verbeteringen aan wat de operator ziet en downloadt. Geen
wijziging aan de FSM, human-in-the-loop-checkpoints, de approval flow, de
leidende Nederlandse verslagprompts (`thematic.md`/`qa.md`), of
`report_type_policies`.

**Dit document is alleen het plan. Er is niets geïmplementeerd.**

---

## 1 — Generatiedatum verwijderen uit het conceptverslag

### Bevinding

Er staat nergens letterlijk "gegenereerd op" in de code, maar het probleem
is structureel hetzelfde: `jobs/runners/draftGenerationRunner.ts` zet
`Draft.date` op `workflow.createdAt.toISOString().slice(0, 10)` — de datum
waarop de workflow is aangemaakt (dus feitelijk het moment van uploaden/
verwerken), niet de datum van het gesprek zelf. `draftGenerator.ts` geeft dit
als vaststaand gegeven mee aan het model (`report_type`, `date`, `subject`
komen "van de workflow/policy, niet van het model" — zie het bestaande
commentaar in `skillEnvelope.ts`); het model wordt er niet eens naar
gevraagd. Bij een workflow die dezelfde dag wordt aangemaakt en afgerond valt
dit toevallig niet op; zodra een transcript van een eerder gesprek later
wordt geüpload, staat er een onjuiste datum in het verslag.

### Voorstel

- `draftGenerator.ts`'s `OUTPUT_SCHEMA` (het code-niveau JSON-schema voor de
  structured output, **niet** `thematic.md`/`qa.md`) krijgt een extra
  optioneel veld, bijvoorbeeld `conversation_date` (`string | null`), met een
  schema-`description` die het model vraagt de datum van het gesprek terug te
  geven **alleen als die expliciet in de brontekst voorkomt** (transcript of
  notities), anders `null`. Dit is een uitbreiding van de structured-output
  schema-definitie in code, geen wijziging van de leidende promptbestanden.
- `draftGenerationRunner.ts` gebruikt dit resultaat in plaats van
  `workflow.createdAt`: `date: parsed.conversation_date ?? "Niet vastgelegd"`
  — dezelfde stijl als de bestaande `attendees.length > 0 ? ... :
  "Niet vastgelegd"`-placeholder, zodat de Fase 14 structurele "Datum
  niet leeg"-check (`reportStructureValidator.ts`) ongewijzigd kan blijven:
  een bewust "niet vastgelegd" telt nog steeds als een niet-lege waarde.
- Geen wijziging aan `report_type_policies`, `reportStructureValidator.ts`'s
  validatieregels zelf, of enige FSM-state.

### Open vraag

Telt het uitbreiden van `draftGenerator.ts`'s `OUTPUT_SCHEMA` (en de
begeleidende instructiezin in de user message, niet de system prompt) voor
jou als een "AI-prompt"-wijziging die eerst goedkeuring nodig heeft, of valt
dat — net als bij Fase 14's `DraftQualityPrecheck`-aanpak — buiten de
"leidende Nederlandse verslagprompts" waar die regel voor bedoeld is? Ik ga
er in dit plan van uit dat het laatste geldt (de systeeminstructie in
`thematic.md`/`qa.md` blijft woordelijk ongewijzigd), maar leg het expliciet
voor omdat dit wel een aanpassing is aan wat er richting het model gaat.

---

## 2 — Kwaliteitscontrole: alleen echt ontbrekende onderdelen als ontbrekend tonen

### Bevinding

Twee samenhangende oorzaken:

1. **Precheck-structuur is te grofmazig voor deze UI.** `draftQualityPrecheck.ts`
   (Fase 14) levert momenteel structurele items (Titel, Aanwezige deelnemers,
   Datum, Onderwerp, Samenvatting, Thematische notulen/Vraag-antwoord-secties)
   plus **twee** LLM-beoordeelde items ("Deelnemers/datum/onderwerp correct
   overgenomen" gebundeld, en "Tekst feitelijk onderbouwd"). De frontend
   (`DraftReviewScreen.tsx`'s `precheckMessage()`) doet vervolgens niets
   anders dan *elk niet-geslaagd item* in één zin opsommen als "ontbreekt nog"
   — inclusief het gebundelde deelnemers/datum/onderwerp-item, dat al faalt
   zodra het model ook maar over één van de drie twijfelt. Dat verklaart
   waarom correcte velden toch als "ontbrekend" verschijnen: ze zaten in een
   gebundeld item dat om een andere reden faalde.
2. **De frontend toont uitsluitend een opsomming van fails, nooit een
   volledige checklist.** Er is geen ✓-weergave voor geslaagde items — de
   gewenste UI (een volledige lijst met ✓/⚠ per item) bestaat simpelweg nog
   niet.

### Voorstel

**Backend — `draftQualityPrecheck.ts`**: vervang de twee vrije LLM-checklist-
items door vier losse, met naam benoemde velden in de `OUTPUT_SCHEMA` (code,
niet het promptbestand): `attendees_correct`, `date_correct`,
`subject_correct`, `factually_grounded` (elk `boolean`), plus een vrije
`issues: string[]` voor de toelichting bij een `false`. Een veld wordt alleen
aan het model gevraagd te beoordelen als het structureel al aanwezig is (een
leeg veld kan niet "correct overgenomen" zijn — dat is dan al een structurele
fail, geen inhoudelijke). Dit vervangt de huidige "sla de hele LLM-aanroep
over als er één structurele fail is"-regel door een fijnmaziger aanpak: velden
die structureel ontbreken worden deterministisch als fail gezet; de overige
velden worden nog steeds aan het model voorgelegd.

`draftQualityPrecheckRunner.ts`/`draftQualityPrecheck.ts` bouwt hieruit een
**vaste checklist van vijf items**, elk met een status-afhankelijke Nederlandse
tekst:

| Item (geslaagd) | Item (gefaald, structureel leeg) | Item (gefaald, inhoudelijk onjuist) |
|---|---|---|
| Deelnemers correct overgenomen | Deelnemers ontbreken | Deelnemers wijken af van het transcript |
| Datum correct overgenomen | Datum ontbreekt | Datum wijkt af van het transcript |
| Onderwerp correct overgenomen | Onderwerp ontbreekt | Onderwerp wijkt af van het transcript |
| Structuur voldoet | Structuur onvolledig | *(n.v.t. -- puur structureel)* |
| Inhoud sluit aan op het transcript | *(n.v.t.)* | Inhoud bevat niet-onderbouwde informatie |

"Structuur voldoet" is een **rollup**: geslaagd alleen als alle overige
structurele items (Titel, Samenvatting, de `bodyContentRule`-check) uit
`checkDraftStructure()` slagen — de granulaire sub-items worden niet meer
los getoond, wat ook meteen `precheckMessage()`'s huidige aanname weghaalt
dat elk checklist-item al een presentabele Nederlandse labeltekst is.

`DraftQualityPrecheckResultSchema` (in `skillEnvelope.ts`) hoeft niet te
wijzigen: `checklist: [{item: string, passed: boolean}]` is generiek genoeg
voor deze vijf vaste items.

**Frontend — `DraftReviewScreen.tsx`**: `precheckMessage()` wordt vervangen
door een component die de volledige `checklist` rendert als lijst, met ✓ voor
`passed: true` en ⚠ voor `passed: false` -- niet langer een enkele
samengevoegde zin die alleen fails noemt.

### Open vraag

Zelfde vraag als bij punt 1: het uitbreiden van `draftQualityPrecheck.ts`'s
`OUTPUT_SCHEMA` met vier benoemde velden (in plaats van de huidige vrije
checklist) raakt niet de tekst van `draftQualityPrecheck.md` zelf, maar wel
hoe strikt het model wordt gestuurd. Akkoord om dit puur op schema/code-niveau
op te lossen, zonder `draftQualityPrecheck.md` aan te passen?

---

## 3 — Bullets op eigen regel

### Bevinding (nog te bevestigen met een live test, zie hieronder)

Twee onafhankelijke, elkaar versterkende oorzaken zijn aannemelijk:

1. **Bevestigd, code-niveau:** `DraftReviewScreen.tsx` rendert sectie-inhoud
   als `<p>{section.content}</p>`. HTML/React collapst standaard elke
   witruimte/newline binnen tekstnodes (geen `white-space: pre-wrap`, geen
   opsplitsing per regel) -- zelfs als `section.content` al keurige
   `\n`-gescheiden bullets bevat, toont de browser ze alsnog aaneengeregen op
   één regel. Dit is een garantie-fout, onafhankelijk van wat het model
   teruggeeft.
2. **Nog te verifiëren:** of het model (`draftGenerator.ts`, via
   `thematic.md`/`qa.md`'s "Schrijf deze op in maximaal 5 zinnen of
   bulletpoints") bullets daadwerkelijk met echte `\n` scheidt, of als één
   aaneengeregen string met "•"-tekens teruggeeft. `finalRenderer.ts`'s
   Markdown-generatie interpoleert `section.content` ongewijzigd; als er wél
   echte newlines in zitten, rendert CommonMark opeenvolgende "- item"-regels
   al correct als lijst zonder verdere aanpassing nodig.

### Voorstel

- **Frontend (in elk geval nodig, dekt oorzaak 1 volledig):**
  `DraftReviewScreen.tsx` rendert sectie-inhoud niet langer als één
  `<p>`, maar splitst op `\n` en rendert elke niet-lege regel als eigen
  `<p>` (of `<li>` voor regels die al met "-"/"•" beginnen). Kleine, lokale
  wijziging, geen prompt- of schemawijziging nodig.
- **Backend, defensief (dekt oorzaak 2 als die zich voordoet, zonder de
  leidende prompts aan te passen):** een kleine, pure normalisatiefunctie
  (bijv. `backend/src/ai/normalizeSectionContent.ts`) die, ná het parsen van
  het model-antwoord in `draftGenerator.ts`, content zonder newlines maar mét
  meerdere "• "/"- "-markeringen in de string alsnog opsplitst in aparte
  regels vóór opslag in `Draft.sections`. Zuivere tekstbewerking, geen
  aanroep naar het model, geen wijziging aan `thematic.md`/`qa.md`. Zodra
  content eenmaal newline-gescheiden is opgeslagen, profiteren zowel de
  React-weergave als de Markdown-/Word-rendering (zie punt 4) hier automatisch
  van.
- Deze normalisatiefunctie is ook precies de plek waar, voor punt 4, tabellen
  (`| Actie | ... |`) en bullets herkend moeten worden om ze om te zetten naar
  echte Word-structuren -- zie hieronder, punt 4's `parseContentBlocks()`.
- **Verificatie:** vóór/tijdens implementatie een korte handmatige test met
  de echte LLM om te bevestigen of oorzaak 2 zich daadwerkelijk voordoet, dan
  wel of de frontend-fix alleen al voldoende is.

---

## 4 — Eindrapport als .docx

### Huidige situatie

`finalRenderer.ts` genereert platte Markdown-tekst; `finalRendererRunner.ts`
slaat die op als `report.md` via `localFilesystemStorage` (die uitsluitend
UTF-8 **strings** ondersteunt, geen binaire content);
`finalReport.routes.ts`'s downloadroute zet `Content-Type: text/markdown` en
een `.md`-bestandsnaam. Er is nog geen Word-generator-dependency in het
project.

### Voorstel

**Nieuwe dependency**: [`docx`](https://www.npmjs.com/package/docx) (MIT,
actief onderhouden, zuiver JavaScript/TypeScript -- genereert native
Open-XML `.docx`, geen externe binary zoals Pandoc nodig). Toegevoegd aan
`backend/package.json`.

**Storage-laag**: `StorageAdapter` (`storage/storageAdapter.ts`) krijgt twee
nieuwe, additieve methoden naast de bestaande tekst-`put`/`get`:
`putBinary(ref: string, content: Buffer): Promise<void>` en
`getBinary(ref: string): Promise<Buffer>`. `localFilesystemStorage.ts`
implementeert ze zonder `"utf8"`-encoding te forceren. De bestaande
tekst-`put`/`get` (transcripts, notes) blijven ongewijzigd -- puur additief,
geen breaking change voor bestaande callers.

**Content-parser** (nieuw, gedeeld met punt 3):
`backend/src/rendering/parseContentBlocks.ts` -- een pure functie die een
sectie-`content`-string omzet naar een array blocks:
`{type: "paragraph", text} | {type: "bullets", items: string[]} |
{type: "table", headers: string[], rows: string[][]}`, op basis van simpele
patroonherkenning (regels beginnend met "- "/"•" -> bullets; regels die
matchen op `| ... | ... |` met een `|---|---|`-scheidingsregel -> tabel;
de rest -> paragraaf). Zuivere tekstlogica, geen model, geen promptwijziging.

**Word-renderer** (nieuw): `backend/src/ai/skills/finalRenderer.ts` krijgt
naast (of in plaats van, zie open vraag) de bestaande `renderContent()` een
`renderDocx(params): Buffer`, die met de `docx`-library een `Document` bouwt:

- Titel -> `HeadingLevel.HEADING_1`
- "Aanwezige deelnemers" / "Datum" / "Onderwerp" -> een korte metadata-alinea
  direct onder de titel (geen aparte heading, zelfde volgorde als nu)
- Elke sectie-heading (Samenvatting, Notulen/Thematische kopjes,
  Vraag/antwoord-secties, Acties en vervolgstappen, Openstaande vragen,
  Bijlagen) -> `HeadingLevel.HEADING_2`
- Sectie-inhoud -> via `parseContentBlocks()`: bullets als echte
  `docx.Paragraph({bullet: {level: 0}})`-items, `| ... |`-tabellen als echte
  `docx.Table`, overige tekst als gewone paragrafen. Geen zichtbare
  Markdown-syntax (`**`, `|`, `-`) in de output.

**Runner**: `finalRendererRunner.ts` roept `renderDocx()` aan in plaats van
`renderContent()`, slaat het resultaat op als
`${workflowId}/final-reports/report.docx` via `storage.putBinary()`, en zet
`FinalReport.format = "docx"` (bestaand vrij tekstveld, geen schemawijziging
nodig).

**Downloadroute**: `finalReport.routes.ts` gebruikt `storage.getBinary()`,
zet `Content-Type:
application/vnd.openxmlformats-officedocument.wordprocessingml.document` en
`Content-Disposition: attachment; filename="eindrapport-${id}.docx"`.

**Frontend**: geen wijziging nodig -- `finalReportDownloadUrl()` is al een
kale URL zonder aannames over bestandsextensie; de browser downloadt wat de
`Content-Disposition`-header zegt. `FinalDownloadScreen.tsx`'s "Formaat:
{finalReport.format}"-regel toont vanzelf "docx".

### Open vraag

Vervangt `.docx` Markdown volledig als opgeslagen eindrapport-formaat (zoals
hierboven uitgewerkt -- `renderContent()`/de `.md`-opslag verdwijnt uit de
RENDER_FINAL-stap), of moet Markdown blijven bestaan als intern/secundair
formaat naast een nieuwe `.docx`-download? De instructie "mag niet langer
**uitsluitend** als Markdown worden aangeboden" plus "de downloadknop moet
een .docx-bestand downloaden" lees ik als: `.docx` wordt het enige
opgeslagen en downloadbare eindrapport-artefact, en dat is ook de eenvoudigste
oplossing (geen twee parallelle renderpaden onderhouden). Bevestig of dat
klopt, of dat je toch Markdown als optie wilt behouden.

---

## Overzicht van voorgestelde wijzigingen

| Bestand | Wijziging |
|---|---|
| `backend/src/ai/skills/draftGenerator.ts` | `OUTPUT_SCHEMA` + user message: optioneel `conversation_date`-veld |
| `backend/src/jobs/runners/draftGenerationRunner.ts` | `date` uit modelresultaat i.p.v. `workflow.createdAt`, met "Niet vastgelegd"-fallback |
| `backend/src/ai/skills/draftQualityPrecheck.ts` | `OUTPUT_SCHEMA` -> 4 benoemde boolean-velden; checklist-opbouw naar 5 vaste, status-afhankelijke items |
| `backend/src/jobs/runners/draftQualityPrecheckRunner.ts` | per-veld LLM-aanroep alleen voor structureel aanwezige velden; "Structuur voldoet"-rollup |
| `frontend/src/routes/DraftReview/DraftReviewScreen.tsx` | volledige ✓/⚠-checklist i.p.v. `precheckMessage()`; sectie-inhoud per regel renderen |
| `backend/src/ai/normalizeSectionContent.ts` (nieuw) | inline bullet-markeringen zonder newline alsnog opsplitsen |
| `backend/src/rendering/parseContentBlocks.ts` (nieuw) | gedeelde parser: paragraaf/bullets/tabel-blocks |
| `backend/src/storage/storageAdapter.ts` + `localFilesystemStorage.ts` | additieve `putBinary`/`getBinary` |
| `backend/src/ai/skills/finalRenderer.ts` | nieuwe `renderDocx()` (via `docx`-package) |
| `backend/src/jobs/runners/finalRendererRunner.ts` | slaat `.docx` op i.p.v. `.md`; `format: "docx"` |
| `backend/src/api/finalReport.routes.ts` | binaire download, docx Content-Type/bestandsnaam |
| `backend/package.json` | nieuwe dependency: `docx` |

## Wat er NIET verandert

- Geen wijziging aan `workflow/transitions.ts`, `workflow/states.ts`, of
  enige FSM-transitie.
- Geen wijziging aan `PENDING_HUMAN_CONFIRMATION` of enig ander
  human-in-the-loop-checkpoint, of aan `approval/gateway.ts`'s
  routeringslogica. `DraftQualityPrecheck` blijft `ADVISORY_ONLY`.
- Geen inhoudelijke wijziging aan `thematic.md`/`qa.md`.
- Geen wijziging aan `report_type_policies` (catalogus, `requiredSections`,
  `bodyContentRule`).

## Openstaande vragen (samengevat)

1. Telt uitbreiding van `draftGenerator.ts`'s structured-output schema (voor
   de conversatiedatum) als een "AI-prompt"-wijziging voor jou, of is dat
   akkoord zolang `thematic.md`/`qa.md` zelf ongewijzigd blijven?
2. Zelfde vraag voor `draftQualityPrecheck.ts`'s schema-uitbreiding (vier
   benoemde velden i.p.v. de vrije checklist).
3. Vervangt `.docx` Markdown volledig als opgeslagen/downloadbaar
   eindrapport-formaat, of moet Markdown blijven bestaan naast `.docx`?

Ik implementeer dit pas na jouw goedkeuring.
