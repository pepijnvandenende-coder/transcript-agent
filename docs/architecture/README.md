# Architecture — Human-in-the-Loop Audit Report Generator

This is the standing source of truth for the system's design, as approved across design review. It is not an implementation plan — see `docs/phase-1/README.md` (and later `docs/phase-2/`, etc.) for what has actually been built.

## Guiding principle

This system is a deterministic, sequential workflow with mandatory human checkpoints — **not** an autonomous agent. Every state transition is either:

- an explicit human action, submitted via the API and validated against the workflow's current state, or
- a system event raised by the Approval Gateway (a later phase) after it validates and scores an AI skill's output against a fixed, pre-configured policy.

The workflow engine never infers, plans, or chooses a transition on its own. It only ever looks up whether a requested transition exists in a single, centrally defined table, and rejects anything that doesn't match.

## System Architecture

```
┌─────────────┐      ┌────────────────────────────────────────────────────┐
│   Web UI    │◄────►│                     Backend API                     │
│             │      │  ┌────────────────────────────────────────────────┐│
│ - Upload    │      │  │            Workflow Engine (FSM)                 ││
│ - Confirm   │      │  │  - applies transitions ONLY after approval       ││
│   low-conf. │      │  │  - enforces allowed edges from current_state     ││
│   AI output │      │  │  - writes audit trail                            ││
│ - Conflict  │      │  └───────────────────▲───────────────────────────┘│
│   review    │      │                      │ approved transition          │
│ - Report    │      │  ┌───────────────────┴───────────────────────────┐│
│   type pick │      │  │        Human Approval Layer (Gateway)          ││
│ - Draft     │      │  │  ┌───────────────┐  ┌────────────────┐        ││
│   review +  │      │  │  │ Schema        │  │ Confidence     │        ││
│   precheck  │      │  │  │ Validator     │  │ Scorer         │        ││
│   banner    │      │  │  └───────┬───────┘  └────────┬───────┘        ││
│ - Download  │      │  │          └──────────┬─────────┘               ││
└─────────────┘      │  │              Policy Resolver                   ││
                      │  │      (auto-approve | mandatory | reject)       ││
                      │  └───────────────────▲───────────────────────────┘│
                      │                      │ raw AI output               │
                      │  ┌───────────────────┴───────────────────────────┐│
                      │  │              Job Queue + Workers                ││
                      │  └───────────────────▲───────────────────────────┘│
                      │                      │                             │
                      │  ┌───────────────────┴───────────────────────────┐│
                      │  │        AI Task Modules ("skills")               ││
                      │  │  each = prompt template + JSON schema + conf.   ││
                      │  │  1 TranscriptQualityChecker                     ││
                      │  │  2 Merger                                       ││
                      │  │  3 ConflictDetector                             ││
                      │  │  4 ReportTypeAdvisor                            ││
                      │  │  5 DraftGenerator                               ││
                      │  │  6 DraftQualityPrecheck                         ││
                      │  │  7 DraftReviser                                 ││
                      │  │  8 FinalRenderer                                ││
                      │  └────────────────────────────────────────────────┘│
                      └───────────────┬──────────────┬────────────────────┘
                                      ▼              ▼
                          ┌───────────────────┐ ┌──────────────────┐
                          │ Relational DB      │ │ Object Storage    │
                          │ - workflows         │ │ - transcripts     │
                          │ - ai_outputs        │ │ - notes           │
                          │ - approval_policies │ │ - drafts/finals   │
                          │ - approval_requests │ │                   │
                          │ - skill_registry    │ │                   │
                          │ - audit trail       │ │                   │
                          └───────────────────┘ └──────────────────┘
```

**Phase 1 builds:** Workflow Engine, its persistence, and the 5 API endpoints in the diagram above. Everything else (Approval Gateway, Job Queue, AI Task Modules, object storage, frontend) is a later phase, represented in the schema/folder structure only as placeholders where noted.

## Workflow States

| # | State | Kind | Approval Gate | On pass | On fail/low-conf |
|---|---|---|---|---|---|
| 1 | `CREATED` | INPUT | — | upload | |
| 2 | `TRANSCRIPT_UPLOADED` | INPUT | — | validate | |
| 3 | `VALIDATING_TRANSCRIPT` | PROCESSING | `AUTO_IF_ABOVE` 0.75 (only if `sufficient=true`) | → `MERGING` | `sufficient=false` → `TRANSCRIPT_INSUFFICIENT`; low conf/invalid → `PENDING_HUMAN_CONFIRMATION` |
| 4 | `TRANSCRIPT_INSUFFICIENT` | CHECKPOINT (mandatory) | | re-upload → `TRANSCRIPT_UPLOADED` | |
| — | `PENDING_HUMAN_CONFIRMATION` (generic, reused) | CHECKPOINT | | confirm → natural next state | retry/edit-retry → back to originating processing state |
| 5 | `MERGING` | PROCESSING | `AUTO_IF_ABOVE` 0.80 | → `DETECTING_CONFLICTS` | low conf/invalid → `PENDING_HUMAN_CONFIRMATION` |
| 6 | `DETECTING_CONFLICTS` | PROCESSING | conflicts found → mandatory; none found → `AUTO_IF_ABOVE` 0.70 | → `SUGGESTING_REPORT_TYPE` | conflicts → `CONFLICTS_PENDING_REVIEW`; low conf & none found → `PENDING_HUMAN_CONFIRMATION` |
| 7 | `CONFLICTS_PENDING_REVIEW` | CHECKPOINT (mandatory) | | explain → `MERGING`, restart → `TRANSCRIPT_UPLOADED` | |
| 8 | `SUGGESTING_REPORT_TYPE` | PROCESSING | `MANDATORY` | → `AWAITING_REPORT_TYPE_SELECTION` | |
| 9 | `AWAITING_REPORT_TYPE_SELECTION` | CHECKPOINT | | choose → `GENERATING_DRAFT` | |
| 10 | `GENERATING_DRAFT` | PROCESSING | `MANDATORY` | → `DRAFT_QUALITY_PRECHECK` | |
| 11 | `DRAFT_QUALITY_PRECHECK` | PROCESSING | `ADVISORY_ONLY` (never gates) | → `DRAFT_PENDING_REVIEW` (always, annotated) | |
| 12 | `DRAFT_PENDING_REVIEW` | CHECKPOINT | | approve → `GENERATING_FINAL`, revise → `REVISING_DRAFT` | |
| 13 | `REVISING_DRAFT` | PROCESSING | `MANDATORY` | → `DRAFT_QUALITY_PRECHECK` | |
| 14 | `GENERATING_FINAL` | PROCESSING | `AUTO` | → `COMPLETED` | |
| 15 | `COMPLETED` | TERMINAL | | | |
| 16 | `CANCELLED` | TERMINAL | | | |
| 17 | `FAILED` | TERMINAL/ERROR | | | retry → originating PROCESSING state |

`CANCELLED` is reachable via an explicit `cancel` action from every non-terminal state.

## Database Model

**Phase 1 tables** (implemented — see `backend/prisma/schema.prisma`):

- `users` — id, name, email, role
- `workflows` — id, title, current_state, report_type, status, created_by, timestamps
- `state_transitions` — the audit trail: workflow_id, from_state, to_state, actor_type, actor_id, ai_output_id (nullable), metadata, occurred_at
- `jobs` — async AI task tracking: workflow_id, job_type, status, input_ref, output_ref, error, attempt_count, result_ai_output_id
- `ai_outputs` — the governance table for every AI call: skill_name, prompt_version, schema_version, raw_output, validation_status/errors, confidence_score, confidence_breakdown, policy_applied, approval_status, approved_by/at, approval_request_id (no FK yet), attempt_number, retry_of_ai_output_id, retry_mode, reviewer_comment
- `approval_policies` — skill_name, policy_type (`auto_if_above` | `mandatory` | `advisory_only`), confidence_threshold, max_retries
- `skill_registry` — skill_name, current_prompt_version, current_schema_version, description

**Later-phase tables** (not created yet): `approval_requests` (groups an `ai_outputs` retry chain into one episode), `ai_output_inputs` (links an `ai_output` to the exact versioned input(s) it consumed), and the AI-domain tables (`transcripts`, `notes`, `merges`, `conflicts`, `report_type_suggestions`, `drafts`, `review_feedback`, `final_reports`) — introduced alongside the AI skills and file uploads that produce them.

Versioning rule: anything regenerable (transcripts, notes, merges, drafts) is versioned via insert-only rows, never mutated in place, once those tables exist.

## Human Approval Layer

```
on job_complete(job):
  output = job.raw_output
  validation = SchemaValidator.check(output, skill.schema)
  if not validation.valid:
      route → PENDING_HUMAN_CONFIRMATION (reason: schema_invalid)
      return
  confidence = ConfidenceScorer.compute(output, skill)
  policy = PolicyResolver.get(skill_name, current_state)
  if policy.type == MANDATORY:
      route → the existing checkpoint state for this step
  elif policy.type == AUTO_IF_ABOVE and confidence >= policy.threshold:
      auto-approve → engine.transition(workflow, policy.next_state)
  else:
      route → PENDING_HUMAN_CONFIRMATION (reason: low_confidence)
```

Raw AI output never reaches the Workflow Engine directly — only the Gateway is permitted to call `engine.transition(...)`.

## Confidence Scoring

```
confidence = clamp(0.7 × llm_self_reported + 0.3 × structural_score, 0, 1)
```

Both components are stored separately (`confidence_breakdown`), never just the final number. Default policy table:

| Skill | Policy | Threshold |
|---|---|---|
| TranscriptQualityChecker | `AUTO_IF_ABOVE` | 0.75 (only applies when `sufficient=true`) |
| Merger | `AUTO_IF_ABOVE` | 0.80 |
| ConflictDetector | `MANDATORY` if conflicts found; else `AUTO_IF_ABOVE` | 0.70 |
| ReportTypeAdvisor | `MANDATORY` | n/a |
| DraftGenerator | `MANDATORY` | n/a |
| DraftQualityPrecheck | `ADVISORY_ONLY` | n/a |
| DraftReviser | `MANDATORY` | n/a |
| FinalRenderer | `AUTO` | n/a |

## AI Quality Precheck

`DraftQualityPrecheck` runs automatically after `DraftGenerator` (and after every `DraftReviser` revision), before the draft reaches the human. It is `ADVISORY_ONLY`: it annotates the draft with a checklist/score/blocking-issues report and always proceeds to `DRAFT_PENDING_REVIEW` — it never blocks or auto-fixes. The human always makes the approve/revise call.

## AI Skill Contract

Every skill's prompt follows the same shape (role/scope/output-contract/confidence instructions → templated context → task instructions → output format → guardrails), and every output is wrapped in a shared envelope:

```json
{
  "skill": "<skill_name>",
  "schema_version": "string",
  "confidence": 0.0,
  "rationale": "string",
  "flags": ["string"],
  "result": { }
}
```

`result` shape per skill: `TranscriptQualityChecker` (`sufficient`, `issues[]`, `metrics`), `Merger` (`merged_sections[]`, `unmatched_notes[]`), `ConflictDetector` (`conflicts[]`), `ReportTypeAdvisor` (`suggested_type`, `rationale`, `runner_up`), `DraftGenerator` (`report_type`, `sections[]`, `coverage`), `DraftQualityPrecheck` (`overall_score`, `checklist[]`, `blocking_issues[]`, `recommendation`), `DraftReviser` (`sections[]`, `changes_applied[]`, `unresolved_feedback[]`), `FinalRenderer` (`rendered: true`, typically template-only, no LLM).

## PENDING_HUMAN_CONFIRMATION: Confirm / Retry / Edit-and-Retry

A human reviewer at this checkpoint has three actions:

1. **Confirm** — accept the AI output; the workflow advances to the state the triggering policy would have reached; an approval event is recorded.
2. **Retry** — re-run the same skill with the same input version; creates a new `ai_outputs` row (new `attempt_number`, `retry_mode = same_input`, `retry_of_ai_output_id` pointing at the previous attempt); the previous attempt is preserved, never overwritten.
3. **Edit input and retry** — the user edits the relevant input (transcript text, notes text, or merged content, depending on which skill is gated); this creates a new version of that input's underlying row; the skill re-runs against the new version (`retry_mode = edited_input`); all previous input and output versions are preserved.

Both retry and edit-retry route the workflow back through the *originating* PROCESSING state (not directly to the next state), so the full Gateway logic (schema validation, confidence scoring, policy resolution) re-runs on the new attempt rather than bypassing it. Retries are bounded by `approval_policies.max_retries` (default 5); beyond that, retry/edit-retry are disabled and the reviewer must confirm or cancel.

Supporting tables (later phase): `approval_requests` (one row per open episode — `intended_next_state`, `attempt_count`, `status`, `resolution`) and `ai_output_inputs` (maps an `ai_outputs` row to the exact versioned input(s) it consumed, enabling both "same input" retries and full lineage reconstruction).

**Audit trail requirements:** append-only everywhere in this subsystem; every retry/edit-retry records its `retry_mode` (never conflating "tried again" with "changed the input"); edited content is preserved verbatim, never diffed-and-discarded; every FSM move logs the `ai_output_id` and (once it exists) `approval_request_id` that justified it; a resolved `approval_requests` episode is never reopened — a later low-confidence event opens a new one.

## API Endpoints (full surface, across all phases)

```
Workflow lifecycle (Phase 1)
  POST   /workflows                    create workflow
  GET    /workflows/:id                 full detail ("get status")
  GET    /workflows/:id/state           current state + allowed actions
  GET    /workflows/:id/history         audit trail
  POST   /workflows/:id/cancel          → CANCELLED

Upload & validation (later phase)
  POST   /workflows/:id/transcript
  POST   /workflows/:id/notes
  POST   /workflows/:id/actions/validate-transcript
  GET    /workflows/:id/transcript/validation

Merge & conflicts (later phase)
  GET    /workflows/:id/conflicts
  POST   /workflows/:id/conflicts/:conflictId/explain
  POST   /workflows/:id/actions/restart-upload

Report type (later phase)
  GET    /workflows/:id/report-type-suggestion
  POST   /workflows/:id/report-type

Draft & review (later phase)
  GET    /workflows/:id/drafts
  GET    /workflows/:id/drafts/:version
  POST   /workflows/:id/drafts/:version/review

Approval gateway (later phase)
  GET    /workflows/:id/approval-request
  GET    /workflows/:id/approval-request/history
  POST   /workflows/:id/approval-request/confirm
  POST   /workflows/:id/approval-request/retry
  POST   /workflows/:id/approval-request/edit-retry

Final (later phase)
  GET    /workflows/:id/final-report
  GET    /workflows/:id/final-report/download
```

## Folder Structure (full, across all phases)

```
backend/
├── prisma/schema.prisma
├── src/
│   ├── api/            # routes + app wiring (Phase 1: workflows only)
│   ├── workflow/        # the FSM: states, transitions, guards, engine, auditTrail (Phase 1)
│   ├── approval/         # Approval Gateway (later phase)
│   ├── ai/               # AI skill modules (later phase)
│   ├── jobs/             # async job queue/workers (later phase)
│   ├── domain/           # shared types (Phase 1)
│   ├── persistence/       # Prisma client + repositories (Phase 1)
│   ├── storage/           # object storage adapter (later phase)
│   ├── auth/              # authentication (later phase)
│   └── config/            # env loading (Phase 1)
├── tests/
│   ├── workflow/          # FSM tests (Phase 1)
│   ├── approval/           # later phase
│   └── ai/                 # later phase
frontend/
├── src/
│   ├── routes/{Upload,ConflictReview,ReportTypeSelection,DraftReview,ConfirmLowConfidence,FinalDownload}/
│   ├── components/
│   ├── api-client/
│   └── state/
docs/
├── architecture/README.md   (this file)
└── phase-1/README.md
```
