# Fase 14 — Nederlandse verslagprompts als leidende generatie-instructies

## Scope

De aangeleverde Nederlandse prompts worden de officiële, leidende specificatie voor `DraftGenerator`. De structurele validatie (`report_type_policies`, `reportStructureValidator.ts`, `DraftQualityPrecheck`) wordt hierop aangepast in plaats van andersom — met als concrete aanleiding de bevinding uit de laatste live AI-test: de conceptcontrole meldde ten onrechte dat "Notulen" ontbrak bij een vraag-en-antwoordverslag, puur omdat de validatie voor beide verslagtypen dezelfde letterlijke kopnamen verwachtte.

**Zoals afgesproken: dit document is alleen het plan.** Er is niets geïmplementeerd. De prompt-inhoud zelf wordt nergens in dit plan gewijzigd — alleen letterlijk overgenomen of, waar nodig, expliciet als openstaande vraag voorgelegd.

## Bevinding 1 — de aangeleverde prompts komen al bijna woordelijk overeen met wat er nu in de code staat

`backend/src/ai/prompts/reportTypes/thematic.md` en `qa.md` (geschreven in Fase 6, ruim vóór mijn betrokkenheid) blijken **inhoudelijk al vrijwel identiek** aan de nu aangeleverde tekst. De AI-instructies, het doel, en de structuur komen woord voor woord overeen. De enige verschillen zijn cosmetisch:

| Plek | Huidige bestanden | Aangeleverde tekst |
|---|---|---|
| Na "Structuur:" | geen lege regel | lege regel |
| "Samenvatting" / "Notulen" als koppen | zonder dubbele punt | met dubbele punt (`Samenvatting:`, `Notulen:`) |
| Samenvatting-instructie | "Schrijf deze op in maximaal 5 zinnen..." | "Maximaal 5 zinnen..." |
| Qa: "desbetreffend kopje" | "desbetreffend kopje" | "dit kopje" |
| Bijlagen-regel | "een kopie van het gebruikte transcript" / "Eventuele verwijzing naar..., etc." | "kopie van gebruikt transcript" / "Eventuele relevante documenten" |

Geen van deze verschillen raakt de betekenis. Omdat de instructie expliciet zegt "gebruik exact onderstaande instructies", is het voorstel om de twee promptbestanden **woordelijk te vervangen** door de nu aangeleverde tekst (byte-voor-byte), zodat er geen enkele twijfel meer bestaat of de prompt "exact" is. Dit is een tekstuele vervanging, geen inhoudelijke wijziging — maar wordt hier toch expliciet gemeld voordat hij wordt doorgevoerd, conform "pas de prompts niet inhoudelijk aan zonder expliciete goedkeuring".

## Bevinding 2 — de kernoorzaak van de "Notulen"-fout

`backend/prisma/schema.prisma`'s `ReportTypePolicy.requiredSections` is een platte lijst met letterlijke kopnamen. `seed.ts` zet voor **beide** typen exact dezelfde waarde: `["Samenvatting", "Notulen"]`. Twee plekken toetsen hier vervolgens letterlijk tegen:

- `backend/src/approval/reportStructureValidator.ts`'s `validateRequiredSections()` — blokkerend, bepaalt schema-geldigheid vóór opslag.
- `backend/src/ai/skills/draftQualityPrecheck.ts`'s `run()` — adviserend, toont de checklist die de operator ziet.

Beide functies doen letterlijk `sections.some(s => s.heading === "Notulen")`. Maar `qa.md` instrueert het model expliciet om **geen** letterlijke "Notulen"-kop te gebruiken voor vraag-en-antwoordverslagen — het model moet per vraag een eigen onderwerpskopje kiezen (`"Het besproken onderwerp/thema als kopje"`). De validatie is dus per ontwerp in tegenspraak met de prompt die ze controleert. Dit bevestigt exact wat de instructie beschrijft: *"De structurele validatie moet aansluiten op de prompts, niet andersom."*

## Ontwerp: type-bewuste validatie zonder de bestaande uitbreidbaarheid te verliezen

Een bestaand, herhaald ontwerpprincipe in deze codebase (zie `schema.prisma`'s eigen commentaar bij `ReportTypePolicy`) is: *"Adding a new report type is one row here plus one prompt file -- no code changes."* Een oplossing die in `reportStructureValidator.ts` hardcoded `if (key === "qa")`-vertakkingen toevoegt, breekt dat principe stilletjes. Het voorstel houdt de validatie daarom **catalogusgedreven**: het gedrag verschilt per rij in `report_type_policies`, niet per hardcoded sleutel in de code.

### Voorgestelde schemawijziging

`ReportTypePolicy` krijgt één nieuw JSON-veld, bijvoorbeeld `bodyContentRule`, naast het bestaande `requiredSections`/`optionalSections`. `requiredSections` blijft bestaan maar wordt beperkt tot de kop die **letterlijk en identiek** in beide prompts voorkomt: `["Samenvatting"]` (niet "Notulen" — dat verdwijnt uit deze lijst voor beide typen, want thematisch gebruikt het wél letterlijk als vaste kop, terwijl qa dat expliciet niet doet; zie hieronder voor hoe dat toch gedekt wordt).

`bodyContentRule` beschrijft **hoe** de hoofdinhoud (het deel dat nu ten onrechte altijd "Notulen" moest heten) gevalideerd moet worden:

```jsonc
// thematic
{ "type": "topic_sections", "minCount": 1 }

// qa
{ "type": "qa_pairs", "minCount": 1 }
```

`reportStructureValidator.ts` (hernoemd naar iets als `validateDraftStructure()`, aangezien de scope breder wordt dan alleen "sections") wordt uitgebreid om, naast de bestaande `requiredSections`-check:

- **`topic_sections`**: telt hoeveel sections overblijven ná aftrek van "Samenvatting" en de bekende optionele koppen (`optionalSections`) — vereist ten minste `minCount` van zulke sections met niet-lege inhoud. Controleert dus dat er inhoudelijke thema-secties zijn, **zonder** hun kopnaam te toetsen — dit is precies "geen exacte kopjes controleren wanneer meerdere geldige varianten bestaan".
- **`qa_pairs`**: telt, binnen diezelfde overgebleven sections, hoeveel er zowel een vraag- als een antwoordmarkering bevatten (bijvoorbeeld een case-insensitieve `"Vraag"`/`"Antwoord"`-check op de inhoud, zoals het model dat al aantoonbaar zelf zo schrijft — zie de output uit de laatste live test: `"Vraag: Hoe importeer ik...\n\nAntwoord: Het importeren kan..."`) — vereist ten minste `minCount`. Toetst dus inhoudelijk of er vraag/antwoord-structuur is, **zonder** ooit naar het woord "Notulen" te zoeken.

Ook `Draft.title`, `Draft.attendees` (niet-lege array) en de door de workflow zelf ingevulde `Draft.date`/`Draft.subject` worden in dezelfde validatiefunctie op niet-leeg gecontroleerd — dit zijn al eigen kolommen op `Draft` (niet `sections`), dus dit is een uitbreiding van de functie, geen kopnaam-check.

**Migratie**: één additieve Prisma-migratie (nieuwe kolom `body_content_rule`, `NOT NULL` met een sane default of expliciet ingevuld per bestaande rij), plus een `seed.ts`-aanpassing die per verslagtype het juiste `bodyContentRule` en het versmalde `requiredSections` zet. Geen wijziging aan bestaande, niet-gerelateerde kolommen.

### DraftQualityPrecheck: dezelfde regel hergebruiken, plus een echte inhoudelijke beoordeling

`draftQualityPrecheck.ts` (nu een Fase 7-stub, zie het bestand se eigen "Phase 7 locked decision"-commentaar) roept dezelfde structurele check aan als `reportStructureValidator.ts` — dat blijft zo, geen duplicatie van regels.

Maar twee van de vier gevraagde controles kunnen **niet** deterministisch: *"Zijn deelnemers, datum en onderwerp correct overgenomen?"* (vergelijking met de bron, niet alleen "niet leeg") en *"Is de tekst feitelijk en gebaseerd op het transcript?"* (feitelijke onderbouwing) vereisen inhoudelijk begrip van het brondocument. Dat kan een deterministische stub principieel niet beoordelen.

**Aanbeveling** (expliciete beslissing, nog te bevestigen — zie "Openstaande vragen"): `DraftQualityPrecheck` wordt, net als `DraftGenerator` (Fase 11) en `ReportTypeAdvisor` (Fase 13) vóór hem, een echte Anthropic-aanroep. De structurele controles (verplichte onderdelen, past de structuur bij het type) blijven een snelle, deterministische voorcontrole — pas als die slaagt, beoordeelt de LLM (met zowel het concept als de brontekst als context) de twee inhoudelijke vragen. Dit past bij het bestaande, adviserende (`ADVISORY_ONLY`) karakter van deze stap: hij blokkeert nooit de workflow, hij informeert de menselijke reviewer beter. Zonder deze stap kan Fase 14 alleen de eerste twee controlepunten ("past de structuur" / "verplichte onderdelen aanwezig") daadwerkelijk waarmaken — de laatste twee zouden dan ongedekt blijven.

## Verificatie van DraftGenerator (geen prompt-wijziging, wel gerichte tests)

De vier controlepunten uit de instructie zijn stuk voor stuk **testbaar zonder de prompt zelf aan te passen**:

- **"De juiste Nederlandse prompt laadt op basis van reportType"** — al aanwezig en getest (`draftGenerator.test.ts` controleert al dat `thematic.md`/`qa.md` als system-prompt wordt meegegeven op basis van `policyKey`). Blijft zo.
- **"Transcript + notities als context meegeeft"** — al zo: `draftGenerationRunner.ts` geeft `mergedContent` mee (de reeds samengevoegde transcript+notities-inhoud van `Merger`). Dit dekt de eis al; wordt bevestigd met een test die controleert dat de samengevoegde inhoud (inclusief een notities-sectie wanneer die er is) in het user-bericht terechtkomt.
- **"Geen Engelse tekst genereert"** — **nu niet geverifieerd.** `ReportTypePolicy.language` bestaat als kolom (`"nl"`) maar wordt nergens gelezen — puur metadata zonder effect. Voorstel: een test die met een gemockte/echte respons controleert of de output op z'n minst geen evident Engelse woorden bevat (een lichte heuristische check, geen taaldetectie-bibliotheek), plús — indien gewenst — één handmatige verificatie met de echte LLM op een transcript met Engelse termen erin (zoals in de laatste live test al impliciet gebeurde, zonder dat het toen specifiek gecontroleerd werd). Als hieruit blijkt dat het model wél afdwaalt naar het Engels, is het instrument om dat te verhelpen een prompt-wijziging — en dat vereist expliciete goedkeuring, dus dat wordt dan als bevinding teruggelegd, niet stilzwijgend opgelost.
- **"Geen samenvatting maakt als vervanging voor het verslag" / "genereert het volledige gespreksverslag"** — gedekt door de nieuwe `bodyContentRule`-check hierboven (minimaal één inhoudelijke sectie naast "Samenvatting"), plus een expliciete test die met een realistisch meerdere-onderwerpen-transcript controleert dat er meerdere secties met substantiële inhoud terugkomen, niet slechts één korte alinea.

## Wat er NIET verandert

Expliciet bevestigd, conform de instructie:

- Geen wijziging aan `workflow/transitions.ts`, `workflow/states.ts`, of enige FSM-transitie.
- Geen wijziging aan `PENDING_HUMAN_CONFIRMATION` of enig ander human-in-the-loop-checkpoint.
- Geen wijziging aan `approval/gateway.ts`'s routeringslogica, policy-uitkomsten, of de bestaande `DRAFT_QUALITY_PRECHECK → DRAFT_PENDING_REVIEW`-overgang (die blijft **onvoorwaardelijk**, precies zoals nu — `DraftQualityPrecheck` blijft `ADVISORY_ONLY` en blokkeert dus nooit, ook niet als hij straks een echte LLM-aanroep wordt).
- Geen wijziging aan `DraftGenerator`'s eigen `MANDATORY`-policy of zijn `bypassEvent`-gedrag.

## Overzicht van voorgestelde wijzigingen

| Bestand | Wijziging |
|---|---|
| `backend/src/ai/prompts/reportTypes/thematic.md` | Vervangen door de exact aangeleverde tekst (cosmetisch) |
| `backend/src/ai/prompts/reportTypes/qa.md` | Vervangen door de exact aangeleverde tekst (cosmetisch) |
| `backend/prisma/schema.prisma` | `ReportTypePolicy` + `bodyContentRule: Json`; nieuwe migratie |
| `backend/prisma/seed.ts` | `requiredSections` versmald tot `["Samenvatting"]`; `bodyContentRule` per type ingevuld |
| `backend/src/approval/reportStructureValidator.ts` | Uitgebreid met `bodyContentRule`-evaluatie (`topic_sections`/`qa_pairs`) en Titel/Aanwezige deelnemers/Datum/Onderwerp-checks; mogelijk hernoemd |
| `backend/src/ai/skills/draftQualityPrecheck.ts` | Structurele check hergebruikt de bovenstaande logica; **indien bevestigd** (zie Openstaande vragen): omgezet naar een echte Anthropic-aanroep voor de twee inhoudelijke controlepunten, naar het patroon van `draftGenerator.ts`/`reportTypeAdvisor.ts` |
| `backend/src/jobs/runners/draftQualityPrecheckRunner.ts` | Geeft, indien de LLM-variant wordt bevestigd, ook de brontekst (samengevoegde inhoud) mee aan de precheck-aanroep |
| `backend/src/persistence/repositories/reportTypePolicyRepository.ts` | Geen functiewijziging nodig — geeft de volledige rij al terug, inclusief het nieuwe veld |

## Teststrategie

- `backend/tests/approval/reportStructureValidator.test.ts`: herzien voor het nieuwe `bodyContentRule`-gedrag —
  - thematisch: meerdere onderwerp-secties met willekeurige, verschillende kopnamen slagen; nul overige secties faalt; kopnaam wordt nooit specifiek gecontroleerd.
  - qa: meerdere secties met Vraag/Antwoord-inhoud slagen, ongeacht kopnaam; een sectie die toevallig "Notulen" heet maar geen vraag/antwoord bevat, faalt **niet** op de naam maar wél op de inhoud (of slaagt, als de inhoud wel een vraag/antwoord-paar bevat) — bevestigt dat er nooit meer op het woord "Notulen" wordt gecontroleerd.
  - Titel/Aanwezige deelnemers/Datum/Onderwerp: leeg attendees-array of lege titel faalt.
- `backend/tests/ai/draftQualityPrecheck.test.ts`: aangepast aan de nieuwe structurele regel; indien de LLM-variant wordt bevestigd, herschreven naar het gemockte-client-patroon van `draftGenerator.test.ts`/`reportTypeAdvisor.test.ts`, met expliciete cases voor "deelnemers/datum/onderwerp correct overgenomen" en "feitelijk gebaseerd op transcript" (gemockte respons die een afwijking signaleert).
- `backend/tests/ai/draftGenerator.test.ts`: nieuwe cases voor "geeft samengevoegde transcript+notities-inhoud door" (al deels gedekt, expliciet gemaakt) en een lichte Engelse-tekst-heuristiek op de gemockte respons-verwerking.
- Nieuwe end-to-end/integratietest (in `backend/tests/jobs/worker.test.ts` of een gerichte nieuwe file): een thematisch én een qa-draft met realistische, meerdere-onderwerpen/meerdere-vragen-inhoud doorlopen `DRAFT_QUALITY_PRECHECK` zonder valse "Notulen ontbreekt"-melding.
- Expliciete regressietest: het exacte scenario uit de laatste live test (Q&A-transcript, LLM-gegenereerde sections met onderwerpskoppen in plaats van "Notulen") mag geen `blocking_issues` meer opleveren.

## Vastgelegde beslissingen

De drie openstaande vragen zijn beantwoord en liggen nu vast:

1. **Promptbestanden woordelijk vervangen** door de nu aangeleverde tekst — bevestigd. `thematic.md`/`qa.md` worden byte-voor-byte overschreven met de aangeleverde instructies, inclusief de dubbele punten en overige cosmetische verschillen uit Bevinding 1.
2. **DraftQualityPrecheck wordt een echte Anthropic-aanroep** — bevestigd. De structurele voorcontrole (verplichte onderdelen, `bodyContentRule`) blijft een snelle deterministische stap vóóraf; pas daarna beoordeelt de LLM (met concept + brontekst als context) of deelnemers/datum/onderwerp correct zijn overgenomen en of de tekst feitelijk op het transcript is gebaseerd. Blijft `ADVISORY_ONLY`, blokkeert dus nooit.
3. **Schema-uitbreiding met `bodyContentRule`** — bevestigd. Nieuw JSON-veld op `report_type_policies`, catalogusgedreven (`topic_sections` voor thematisch, `qa_pairs` voor vraag/antwoord), zoals uitgewerkt hierboven.

Het plan is hiermee compleet vastgesteld. Ik implementeer dit pas na een expliciete instructie daartoe.
