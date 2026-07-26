# Phase 2 — Upload, Validation & the First Gateway Vertical Slice

## Scope

Phase 2 builds the first complete vertical slice through the architecture in `docs/architecture/README.md`: a transcript is uploaded, stored, validated by an AI skill, scored and routed by the Approval Gateway, and the result lands as a real FSM transition with a full audit trail. The goal is to prove every layer of the design — Object Storage, Job Queue, an AI skill, and the Human Approval Layer — end to end for exactly one skill (`TranscriptQualityChecker`) before repeating the same pattern for the remaining seven skills in later phases.

Concretely, Phase 2 makes the following state path real:

```
CREATED → TRANSCRIPT_UPLOADED → VALIDATING_TRANSCRIPT → { MERGING | TRANSCRIPT_INSUFFICIENT | PENDING_HUMAN_CONFIRMATION }
```

It deliberately does **not** include real LLM calls, retry/edit-retry, or anything past `MERGING`. See `docs/architecture/README.md` for the full design this phase is a first slice of.

## Out of Scope

- **Real LLM calls.** `TranscriptQualityChecker` returns a deterministic stubbed output matching the shared skill envelope. No Anthropic API integration, prompt templates, or API key configuration in this phase.
- **Retry / edit-and-retry.** `PENDING_HUMAN_CONFIRMATION` supports **confirm only** in this phase. The retry lineage (`attempt_number`, `retry_of_ai_output_id`, `retry_mode`) is real in the schema but not exercised until the phase that builds `Merger`/`DraftGenerator`, where retries matter more.
- **Merger and everything downstream of `MERGING`.** Conflict detection, report type selection, draft generation/review, and final rendering are later phases.
- **External queue infrastructure.** No Redis/BullMQ. The Job Queue is a Postgres-polling worker against the existing `jobs` table.
- **Remote object storage.** No S3/MinIO. Storage is a local filesystem adapter behind an interface, swappable later without touching callers.
- **Authentication.** Same Phase 1 simplification continues — `createdById`/`actorId`/`uploadedBy` are caller-supplied `users.id` values.

## Architecture Flow (this phase)

```
POST /workflows/:id/transcript
        │  (multipart/text body)
        ▼
  storage/localFilesystemStorage.put()  ──►  transcripts row (versioned, insert-only)
        │
        ▼
POST /workflows/:id/actions/validate-transcript
        │
        ▼
  jobs/queue.ts  ──►  jobs row (job_type=VALIDATE_TRANSCRIPT, status=QUEUED)
        │
        ▼
  jobs/worker.ts  (Postgres-polling loop)
        │  claims job, status → RUNNING
        ▼
  jobs/runners/validateTranscriptRunner.ts
        │  loads the transcript, calls the skill
        ▼
  ai/skills/transcriptQualityChecker.ts  (stub)
        │  returns { skill, schema_version, confidence, rationale, flags, result: { sufficient, issues[], metrics } }
        ▼
  ai_outputs row written (validation_status, confidence_score, confidence_breakdown, raw_output)
        │
        ▼
  approval/gateway.ts  — on_job_complete(job)
        │  1. schemaValidator.check(output)        → invalid          → PENDING_HUMAN_CONFIRMATION (reason: schema_invalid)
        │  2. policyResolver: result.sufficient === false              → engine.transition(..., TRANSCRIPT_INSUFFICIENT)
        │  3. confidenceScorer.compute(output)      → below threshold  → PENDING_HUMAN_CONFIRMATION (reason: low_confidence)
        │  4. else                                                     → engine.transition(..., MERGING)
        ▼
  workflow/engine.ts  (unchanged from Phase 1 — the Gateway is just another caller)
        │
        ▼
  state_transitions row (audit trail, unchanged shape from Phase 1)
```

`gateway.ts` remains the only module outside `workflow/` permitted to call `engine.transition(...)`, per the architecture doc's guiding principle — raw AI output never reaches the Workflow Engine directly.

## Database Changes

One new Prisma migration, additive only — no changes to Phase 1 tables or enums.

| Table | Columns | Notes |
|---|---|---|
| `transcripts` | `id`, `workflow_id`, `version`, `storage_ref`, `uploaded_by`, `created_at` | Insert-only; a re-upload creates a new version row, never overwrites. `(workflow_id, version)` unique. |
| `notes` | `id`, `workflow_id`, `version`, `storage_ref`, `uploaded_by`, `created_at` | Same versioning rule as `transcripts`. Persisted this phase; not read until the Merger phase. |
| `approval_requests` | `id`, `workflow_id`, `ai_output_id`, `intended_next_state`, `attempt_count`, `status`, `resolution`, `created_at`, `resolved_at` | One row per open Gateway episode, per architecture doc. A resolved episode is never reopened. |
| `ai_output_inputs` | `id`, `ai_output_id`, `input_type`, `input_id`, `input_version` | Polymorphic lineage join. `input_id` intentionally has no FK, matching the existing unconstrained-column pattern already used for `ai_outputs.approval_request_id`. |

`ai_outputs` and `jobs` already exist from Phase 1 and are populated for the first time in this phase, with no schema changes required.

## New Modules

| Path | Responsibility |
|---|---|
| `src/storage/storageAdapter.ts` | Storage interface: `put(ref, content)` / `get(ref)`. |
| `src/storage/localFilesystemStorage.ts` | Local-disk implementation of the adapter; root directory from `STORAGE_ROOT_DIR`. Resolves every `storage_ref` to an absolute path and rejects (throws) any ref that resolves outside `STORAGE_ROOT_DIR` — e.g. `../`-style traversal or an absolute path override — so a malformed or malicious `storage_ref` can never read/write outside the storage root. |
| `src/ai/skillEnvelope.ts` | Zod schema for the shared `{skill, schema_version, confidence, rationale, flags, result}` envelope from the architecture doc. |
| `src/ai/skills/transcriptQualityChecker.ts` | Stubbed skill: returns a fixed, valid envelope with `result.sufficient/issues/metrics`. |
| `src/jobs/queue.ts` | `enqueue()` — inserts a `jobs` row with status `QUEUED`. |
| `src/jobs/worker.ts` | Exposes `processNextJob()` — claims and runs a single `QUEUED` job to completion (`RUNNING` → dispatch to the matching runner → `SUCCEEDED`/`FAILED`), returning whether a job was found. This is the function tests call directly. Also exposes `runPollingLoop()`, a thin wrapper that calls `processNextJob()` on an interval (`WORKER_POLL_INTERVAL_MS`). Phase 2 does not require an always-running daemon for its tests — they exercise `processNextJob()` synchronously against fixture rows — but real usage needs `npm run worker` (below) actually running for queued jobs to ever complete. |
| `src/jobs/workerMain.ts` | Entry point for `npm run worker`: starts `runPollingLoop()`. Deliberately **not** started by `src/api/server.ts` — the API server only enqueues jobs, it never runs them, so the worker is its own process. |
| `src/jobs/runners/validateTranscriptRunner.ts` | Maps `job_type=VALIDATE_TRANSCRIPT` to `transcriptQualityChecker`, writes the resulting `ai_outputs` row. |
| `src/approval/schemaValidator.ts` | Validates `raw_output` against the skill envelope schema. |
| `src/approval/confidenceScorer.ts` | `confidence = clamp(0.7 × llm_self_reported + 0.3 × structural_score)`; `structural_score` is a fixed stub value in this phase. |
| `src/approval/policyResolver.ts` | Reads `approval_policies`; includes the per-skill hook that reads `result.sufficient` for `TranscriptQualityChecker` — the template later skills (e.g. `ConflictDetector`'s "conflicts found" branch) will reuse. |
| `src/approval/gateway.ts` | `on_job_complete(job)` orchestration; the sole caller of `engine.transition()` for AI-driven moves. |
| `src/persistence/repositories/transcriptRepository.ts`, `noteRepository.ts`, `jobRepository.ts`, `aiOutputRepository.ts`, `approvalRequestRepository.ts` | Data access for the new/newly-populated tables, following the Phase 1 repository pattern. |
| `prisma/seed.ts` | Upserts the `approval_policies` row(s) Phase 2 needs (`TranscriptQualityChecker`, `AUTO_IF_ABOVE` @ 0.75). Idempotent; run via `prisma db seed`. Later phases add their own skill's row here. |

## API Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/workflows/:id/transcript` | Upload a transcript; stores content, writes a new `transcripts` version row, and fires the `upload_transcript` action (`CREATED` → `TRANSCRIPT_UPLOADED`) |
| POST | `/workflows/:id/notes` | Upload notes; stores content, writes a new `notes` version row |
| POST | `/workflows/:id/actions/validate-transcript` | Enqueues the `VALIDATE_TRANSCRIPT` job for the latest transcript version |
| GET | `/workflows/:id/transcript/validation` | Returns the latest `ai_outputs` row for this workflow's validation step |
| GET | `/workflows/:id/approval-request` | Returns the open `approval_requests` episode, if any |
| POST | `/workflows/:id/approval-request/confirm` | Confirms the pending AI output; advances the workflow to the state the triggering policy would have reached |

Retry and edit-retry are intentionally absent from this list — see Out of Scope.

**Confirm semantics.** `POST /workflows/:id/approval-request/confirm` only accepts a workflow currently at `PENDING_HUMAN_CONFIRMATION` with an open `approval_requests` episode — otherwise it 4xxs. It does **not** re-run the AI skill; it takes the existing `ai_outputs` row for that episode and routes it back through `approval/gateway.ts` (marking the episode `resolution=confirmed` and treating the output as approved), so `gateway.ts` remains the single caller of `engine.transition()` even on the human-confirm path, not just the automatic one.

## Test Strategy

- `tests/storage/` — filesystem adapter: put/get round-trips, path/versioning behavior, and rejection of path-traversal `storage_ref` values (`../`, absolute paths, encoded variants). No DB needed.
- `tests/jobs/` — queue enqueue + `processNextJob()` claim/run/complete lifecycle, called directly (no daemon) against a real Postgres instance, following the Phase 1 convention of throwaway fixture rows cleaned up in dependency order in `afterAll`.
- `tests/ai/` — `transcriptQualityChecker` stub returns an envelope that validates against `skillEnvelope.ts`; deterministic across calls.
- `tests/approval/` — `schemaValidator`, `confidenceScorer`, and `policyResolver` unit tests (pure logic, no DB), plus `gateway.ts` integration tests covering all three routing outcomes (`MERGING`, `TRANSCRIPT_INSUFFICIENT`, `PENDING_HUMAN_CONFIRMATION`) against a real database, mirroring the structure of `tests/workflow/engine.test.ts`.
- Existing Phase 1 tests (`tests/workflow/*`) are unchanged and must continue to pass unmodified — this phase only adds callers of `engine.transition()`, it does not touch the engine itself.

## Setup & Running

Builds on the Phase 1 setup (`npm install`, `.env`, `npm run prisma:generate`, `npm run prisma:migrate`) in `docs/phase-1/README.md`. Additional Phase 2 steps:

1. `npx prisma db seed` — seeds the `approval_policies` row(s) Phase 2 needs (currently just `TranscriptQualityChecker`, `AUTO_IF_ABOVE` @ 0.75; see `prisma/seed.ts`). Safe to re-run any time — it's an upsert. `prisma migrate dev` also runs this automatically after applying a migration, unless invoked with `--skip-seed`.
2. `npm run dev` — starts the API server (unchanged from Phase 1). It only ever **enqueues** jobs; it does not process them.
3. `npm run worker` — starts the job worker's `runPollingLoop()` in its own process, polling for `QUEUED` jobs every `WORKER_POLL_INTERVAL_MS` (default 2000ms). This must be running — as a separate terminal/process alongside `npm run dev` — for an enqueued `VALIDATE_TRANSCRIPT` job to ever complete. The worker is intentionally **not** started by the API server (see `src/jobs/workerMain.ts`), so it can be run, restarted, or scaled independently of request handling.

For local development, steps 1–3 all need to happen at least once (seed) or stay running (dev server + worker) before exercising the API end to end — see Manual End-to-End Verification below.

## Environment Changes

- New env var: `STORAGE_ROOT_DIR` — local filesystem root for uploaded transcripts/notes. Documented in `.env.example`.
- New env var: `WORKER_POLL_INTERVAL_MS` — how often `npm run worker` polls for `QUEUED` jobs when the queue is empty (default 2000ms). Only affects `runPollingLoop()`, not `processNextJob()` itself.
- No changes to `DATABASE_URL` or `PORT`.

## Manual End-to-End Verification

A checklist for exercising the full pipeline outside the automated tests. Requires `npm run dev` and `npm run worker` both running, and `npx prisma db seed` already applied. All request bodies are JSON.

**0. Create a test user.** There is no Users API yet (same Phase 1 simplification) — create one via Prisma Studio (`npx prisma studio`) or a one-off script, and note its `id`.

**1. Auto-approved path (the common case).**
1. `POST /workflows` `{ "title": "Manual Test 1", "createdById": "<userId>" }` → note the workflow `id`.
2. `POST /workflows/:id/transcript` `{ "uploadedById": "<userId>", "content": "This is a normal transcript with real words in it." }`.
3. `POST /workflows/:id/actions/validate-transcript` `{ "actorId": "<userId>" }` → response should show `currentState: "VALIDATING_TRANSCRIPT"`.
4. Within `WORKER_POLL_INTERVAL_MS` of the worker running, poll `GET /workflows/:id/state` → expect `currentState: "MERGING"`.
5. `GET /workflows/:id/transcript/validation` → expect `validationStatus: "VALID"`, `approvalStatus: "AUTO_APPROVED"`, `policyApplied: "AUTO_IF_ABOVE"`.
6. `GET /workflows/:id/history` → expect the full chain `CREATED → TRANSCRIPT_UPLOADED → VALIDATING_TRANSCRIPT → MERGING`, with the last row's `actorType` = `SYSTEM`.

*Why this is the "common case": the stub always returns `confidence: 0.9` for a non-empty transcript, and `computeConfidence(0.9)` ≈ 0.885, comfortably above the seeded 0.75 threshold — any non-empty transcript auto-approves.*

**2. Insufficient path.**
1. New workflow, upload a transcript with whitespace-only content (e.g. `" "` — passes the `min(1)` character check but has 0 words).
2. `POST .../actions/validate-transcript`, wait for the worker.
3. `GET /workflows/:id/state` → expect `currentState: "TRANSCRIPT_INSUFFICIENT"`, `allowedActions` including `reupload_transcript` and `cancel`.

**3. Low-confidence checkpoint + confirm path (requires a temporary policy edit).** The stub's confidence is fixed (0.9 when sufficient), so it never naturally falls below the default 0.75 threshold — this path can't be reached with the seeded policy as-is.
1. Via Prisma Studio, edit the `approval_policies` row for `TranscriptQualityChecker`: raise `confidence_threshold` to `0.95` (temporarily).
2. New workflow, upload a normal (non-empty) transcript, submit for validation, wait for the worker.
3. `GET /workflows/:id/state` → expect `currentState: "PENDING_HUMAN_CONFIRMATION"`.
4. `GET /workflows/:id/approval-request` → expect an open episode, `status: "PENDING"`.
5. `POST /workflows/:id/approval-request/confirm` `{ "actorId": "<userId>" }` → expect `currentState: "MERGING"`.
6. `GET /workflows/:id/transcript/validation` → expect `approvalStatus: "HUMAN_APPROVED"`, `approvedById` set to `<userId>`.
7. `GET /workflows/:id/approval-request` → now 404 (episode resolved, no longer open).
8. **Reset the policy** — set `confidence_threshold` back to `0.75` (or re-run `npx prisma db seed`) before further testing.

**4. Regression check.** `POST /workflows/:id/cancel` on any non-terminal workflow from step 1–3 still works and moves it to `CANCELLED` (unchanged Phase 1 behavior).

**Not manually reachable via the live API in Phase 2** (covered only by automated tests, not this checklist):
- The **schema-invalid** routing branch — the stub always produces a schema-valid envelope by construction, so this path only exists in `tests/approval/gateway.test.ts`, which calls `handleSkillOutput()` directly with a deliberately malformed envelope.
- The **"no runner registered"** job failure path in `worker.ts` — only `VALIDATE_TRANSCRIPT` jobs are ever enqueued by the API, so this is only exercised in `tests/jobs/worker.test.ts` by inserting a `Job` row with an unhandled `job_type` directly.
- **Path traversal rejection** in `localFilesystemStorage.ts` — `storage_ref` is always server-generated from `workflowId`/version, never taken from request input, so there's no API request that can trigger `PathTraversalError`. Covered by `tests/storage/localFilesystemStorage.test.ts` instead.

## Locked Decisions

These were open questions in the architecture/Phase 1 docs, resolved for this phase during planning discussion:

1. **Slice boundary** — Phase 2 stops at `MERGING`; it does not include `Merger` or anything past it.
2. **AI output is stubbed**, not a real Claude API call. Real LLM integration is a later phase.
3. **Job queue = Postgres-polling** against the existing `jobs` table, in-process worker. No new infrastructure dependency (no Redis/BullMQ).
4. **Object storage = local filesystem adapter** behind `storage/storageAdapter.ts`. Swappable for S3/MinIO later without touching callers.
5. **`PENDING_HUMAN_CONFIRMATION` gets confirm only** in this phase. Retry/edit-retry wait for the phase that builds `Merger`/`DraftGenerator`, where retry lineage actually matters.
6. **`PolicyResolver` gets a minimal per-skill hook now** (reads `result.sufficient`), rather than staying fully generic. This is the template later skills' semantic branches (e.g. `ConflictDetector`'s "conflicts found" branch) will reuse.
