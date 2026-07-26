# Phase 3 — Merger + Retry/Edit-and-Retry Activation

## Scope

Phase 3 extends the vertical slice Phase 2 proved out (`docs/phase-2/README.md`) one step further through the architecture in `docs/architecture/README.md`, and closes a gap Phase 2 deliberately deferred:

```
MERGING → { DETECTING_CONFLICTS | PENDING_HUMAN_CONFIRMATION }
```

- The **`Merger`** skill: the second AI skill built (after `TranscriptQualityChecker`), and the first to consume two inputs (transcript + optional notes).
- **Retry and edit-and-retry** at `PENDING_HUMAN_CONFIRMATION`, activated generically for every registered skill rather than Merger-specific. Phase 2 explicitly deferred this ("wait for the phase that builds Merger/DraftGenerator, where retry lineage actually matters") — this is that phase. Because routing is resolved per-skill via the checkpoint's own `ai_output.skillName`, the same mechanism also lights up `retry.transcript_validation` / `edit_retry.transcript_validation`, edges that existed in `workflow/transitions.ts` since Phase 1 but were never reachable until now.

No changes were needed in `workflow/transitions.ts` or `workflow/states.ts` — every edge this phase uses (`merge.*` events, `confirm.merge`/`retry.merge`/`edit_retry.merge`, the equivalent `transcript_validation` retry edges, `JobType.MERGE`) was already hand-authored in Phase 1, ahead of the code that would exercise it. This phase is purely about wiring real skill/gateway/job code onto FSM edges that already existed.

## Out of Scope

- **`ConflictDetector`, the `conflicts` table, and anything past `DETECTING_CONFLICTS`'s entry.** Report type selection, draft generation/review, and final rendering remain later phases.
- **Real LLM calls.** `Merger` returns a deterministic stubbed output matching the shared skill envelope, same locked pattern as `TranscriptQualityChecker`.
- **Frontend, authentication.** Same simplifications as Phases 1–2 continue.
- **`GET /workflows/:id/approval-request/history`.** The architecture doc lists it alongside retry/edit-retry, but `GET /workflows/:id/history` (state_transitions, already carrying `aiOutputId`/`approvalRequestId` in metadata) covers auditability for now.
- **Retrofitting `ai_output_inputs` lineage writes into `TranscriptQualityChecker`'s runner.** It's populated for `Merger` only — its first real use case (two inputs). `validateTranscriptRunner.ts` still doesn't pass an `inputs` array to `handleSkillOutput()`.
- **Resolving which `merges` version a future `ConflictDetector` should read** when a low-confidence Merger attempt also wrote a row that was never approved. Left for the phase that builds `ConflictDetector`.
- **Hardening the race between "MERGE job enqueued against latest transcript/notes" and a new upload landing before the worker runs.** Not addressed.

## Architecture Flow (this phase)

```
(workflow enters MERGING -- via TranscriptQualityChecker auto-approval or a
 human confirm, both already Phase 2 code)
        │
        ▼
  approval/gateway.ts's enqueueForStateEntry()
        │  MERGING has a registered skill (Merger) -> auto-enqueues a MERGE
        │  job immediately. No "start merge" endpoint exists -- entering a
        │  skill's own PROCESSING state is what starts its job, uniformly,
        │  whether that state was reached by auto-approval, a human confirm,
        │  or (see below) a retry/edit-retry.
        ▼
  jobs/worker.ts  (Postgres-polling loop, unchanged from Phase 2)
        │  claims the MERGE job, status → RUNNING
        ▼
  jobs/runners/mergeRunner.ts
        │  loads the latest transcript (required) + latest notes (optional)
        ▼
  ai/skills/merger.ts  (stub)
        │  returns { skill, schema_version, confidence, rationale, flags,
        │            result: { merged_sections[], unmatched_notes[] } }
        │  confidence varies with notes-presence (0.92 with notes, 0.65
        │  without) -- unlike Phase 2's fixed-confidence stub, both the
        │  auto-approve and low-confidence Gateway paths are reachable live
        │  at the seeded 0.80 threshold, with no temporary policy edit needed
        ▼
  ai_outputs row written; ai_output_inputs rows written (transcript + notes
  lineage) -- Merger is the first skill to populate this table
        │
        ▼
  approval/gateway.ts -- handleSkillOutput(), same on_job_complete shape as
  Phase 2, now also computing attempt_number from retryOfAiOutputId when the
  job was a retry
        │  schema invalid          → PENDING_HUMAN_CONFIRMATION (reason: schema_invalid)
        │  confidence >= 0.80      → engine.transition(..., DETECTING_CONFLICTS)
        │  confidence < 0.80       → PENDING_HUMAN_CONFIRMATION (reason: low_confidence)
        ▼
  jobs/runners/mergeRunner.ts writes a `merges` row (versioned, one per
  schema-valid attempt, regardless of eventual approval outcome)
        ▼
  workflow/engine.ts  (unchanged -- the Gateway is just another caller)
```

**The retry / edit-and-retry path** (from `PENDING_HUMAN_CONFIRMATION`, for either skill registered so far):

```
POST /workflows/:id/approval-request/retry            { actorId, reviewerComment? }
POST /workflows/:id/approval-request/edit-retry        { actorId, transcriptContent?, notesContent?, reviewerComment? }
        │
        ▼
  approval/gateway.ts -- retryApprovalRequest() / editRetryApprovalRequest()
        │  1. must be at PENDING_HUMAN_CONFIRMATION with an open episode      (else 409 / 404)
        │  2. episode.attemptCount >= approval_policies.maxRetries            → 409 MaxRetriesExceededError
        │  3. (edit-retry only) requested input type must be one the         → 400 InvalidRetryInputError
        │     checkpoint's skill actually consumes (routing.inputs)
        │  4. (edit-retry only) createTranscriptVersion/createNoteVersion --
        │     new insert-only version, nothing overwritten
        │  5. resolve the old approval_requests episode ("retried" / "edited_input")
        │  6. engine.transition() with the skill's retryAction/editRetryAction --
        │     routes back through the *originating* PROCESSING state, so the
        │     full Gateway logic re-runs on the new attempt rather than being
        │     bypassed
        │  7. enqueueForStateEntry() re-enqueues that skill's job, tagged with
        │     retryOfAiOutputId + retryMode (SAME_INPUT / EDITED_INPUT)
        ▼
  (the re-enqueued job runs through the same skill/gateway path above; the new
   ai_outputs row's attempt_number is computed from the output it's retrying)
```

`gateway.ts` remains the only module outside `workflow/` permitted to call `engine.transition()`, per the architecture doc's guiding principle — raw AI output never reaches the Workflow Engine directly, and neither does a raw retry/edit-retry request.

## Database Changes

One new Prisma migration (`phase3_merger_and_retry`), additive only — no changes to any Phase 1/2 table's existing columns or enums.

| Table | Change | Notes |
|---|---|---|
| `merges` (new) | `id`, `workflow_id`, `version`, `ai_output_id`, `merged_sections` (json), `unmatched_notes` (json), `created_at` | Insert-only, one row per schema-valid Merger attempt regardless of approval outcome. `(workflow_id, version)` unique. Written by `mergeRunner.ts`, not the gateway, so `approval/gateway.ts` stays skill-agnostic. |
| `jobs` | + `retry_of_ai_output_id` (FK → `ai_outputs`, nullable), `retry_mode` (existing `RetryMode` enum, nullable) | Set only when a job was enqueued by a retry/edit-retry; threaded through to `handleSkillOutput()` so it can compute the new `ai_outputs` row's `attempt_number`/lineage. |

No `WorkflowState`, `JobType`, `AiOutputInputType`, or `RetryMode` enum changes — all were already complete from Phase 1. `approval_requests` and `ai_output_inputs` (created empty in Phase 2) are populated by real code for the first time this phase.

`prisma/seed.ts` gained a second `approval_policies` upsert: `Merger`, `AUTO_IF_ABOVE`, threshold `0.80` (per the architecture doc's policy table).

## New Modules

| Path | Responsibility |
|---|---|
| `src/ai/skills/merger.ts` | Stubbed skill: `run(transcriptContent, notesContent?)` returns a deterministic envelope. Confidence depends on notes-presence (see Locked Decisions). |
| `src/jobs/runners/mergeRunner.ts` | Loads the latest transcript + optional latest notes, calls the skill, calls `handleSkillOutput()` with lineage `inputs` and any retry context, then writes the `merges` row. |
| `src/persistence/repositories/mergeRepository.ts` | `createMergeVersion()`, `findLatestMerge()` (the latter unused until the phase that builds `ConflictDetector`). |
| `src/persistence/repositories/aiOutputInputRepository.ts` | `createAiOutputInputs()` — bulk insert into `ai_output_inputs`. |

## Modified Modules

| Path | What changed |
|---|---|
| `src/approval/gateway.ts` | Central change of this phase. `SkillRouting` gained `originatingState`, `retryAction`, `editRetryAction`, `jobType`, `inputs`; a `Merger` entry was added. A `JOB_FOR_STATE` map (derived from `SKILL_ROUTING`) plus `enqueueForStateEntry()` now runs after every `engine.transition()` in this file, auto-starting a skill's job the moment its PROCESSING state is entered — this is what starts `MERGE` jobs with no dedicated "start merge" endpoint. `handleSkillOutput()` gained `retryOfAiOutputId`/`retryMode`/`inputs` params and computes `attempt_number`. New exported `retryApprovalRequest()` and `editRetryApprovalRequest()`, siblings of the existing `confirmApprovalRequest()`. |
| `src/approval/policyResolver.ts` | + `getMaxRetries(skillName)`, used by the retry-budget check. |
| `src/approval/schemaValidator.ts` | Registered `Merger: MergerEnvelopeSchema`. |
| `src/ai/skillEnvelope.ts` | + `MergedSectionSchema`, `MergerResultSchema`, `MergerEnvelopeSchema`. |
| `src/domain/types.ts` | + `MaxRetriesExceededError`, `InvalidRetryInputError`. |
| `src/api/errorHandler.ts` | Maps the two new errors to 409 and 400 respectively. |
| `src/api/approvalRequest.routes.ts` | + `POST .../approval-request/retry`, `POST .../approval-request/edit-retry`. |
| `src/persistence/repositories/aiOutputRepository.ts` | `createAiOutput()` gained `attemptNumber`/`retryOfAiOutputId`/`retryMode`; + `updateAiOutputReviewerComment()` (attaches a reviewer's comment to the **old** output being retried, not the new attempt). |
| `src/persistence/repositories/approvalRequestRepository.ts` | `createApprovalRequest()` gained `attemptCount`, seeded from the computed `attempt_number` so it accumulates correctly across a chain of resolved episodes. |
| `src/persistence/repositories/jobRepository.ts`, `src/jobs/queue.ts` | Threaded `retryOfAiOutputId`/`retryMode` through job creation. |
| `src/jobs/worker.ts` | Registered `JobType.MERGE`; `JobRunnerInput` gained `retryOfAiOutputId`/`retryMode`, populated from the claimed row. |
| `src/jobs/runners/validateTranscriptRunner.ts` | Falls back to the workflow's latest transcript when `inputRef` is absent — retry-enqueued jobs never set it, since `enqueueForStateEntry()` is skill-agnostic. The explicit-`inputRef` path used by `validation.routes.ts`'s initial enqueue is unchanged. |

## API Endpoints

| Method | Path | Body | Purpose |
|---|---|---|---|
| POST | `/workflows/:id/approval-request/retry` | `{ actorId, reviewerComment? }` | Re-run the checkpoint's skill against the same input version(s) |
| POST | `/workflows/:id/approval-request/edit-retry` | `{ actorId, transcriptContent?, notesContent?, reviewerComment? }` (at least one content field required) | Record a new version of the edited input(s), then re-run |

No new "start merge" endpoint — confirmed absent from the architecture doc's full API list; handled entirely by `enqueueForStateEntry()` inside `gateway.ts`.

## Test Strategy

- `tests/ai/merger.test.ts` — stub determinism, envelope validity, confidence branches on notes-presence.
- `tests/approval/schemaValidator.test.ts`, `tests/approval/policyResolver.test.ts` — extended with `Merger` cases (plain `AUTO_IF_ABOVE`, no semantic hook) and `getMaxRetries()` coverage.
- `tests/approval/gateway.test.ts` — extended with Merger's three routing outcomes; the auto-enqueue mechanism (auto-approving into `MERGING` enqueues a `MERGE` job with no explicit call); retry re-entering the originating state and enqueuing a `SAME_INPUT` job whose eventual output has `attempt_number = 2`; edit-retry creating a new transcript version and enqueuing an `EDITED_INPUT` job; `InvalidRetryInputError` on a mismatched edit-retry input type; `MaxRetriesExceededError` once `attemptCount` reaches the policy's `maxRetries`.
- `tests/jobs/worker.test.ts` — the pre-existing "no runner registered" case switched from `JobType.MERGE` (now registered) to `JobType.DETECT_CONFLICTS`; added end-to-end `MERGE` job processing (`MERGING → DETECTING_CONFLICTS`, a `merges` row written); added a dedicated-workflow retry-lineage test using the real `retryApprovalRequest()` path.
- `tests/api/approvalRequest.routes.test.ts` (new) — real-HTTP-server coverage of retry/edit-retry: success paths, 400 on an empty edit-retry body, 409 when not at the checkpoint.
- `tests/workflow/*`, `tests/storage/*` — unchanged, continue passing unmodified (no `transitions.ts`/`states.ts` changes).

## Setup & Running

Builds on Phase 1/2 setup. Additional Phase 3 step:

1. `npx prisma migrate dev` then `npx prisma db seed` — applies the `phase3_merger_and_retry` migration and seeds the `Merger` policy row (`AUTO_IF_ABOVE` @ 0.80) alongside the existing `TranscriptQualityChecker` row.

`npm run dev` and `npm run worker` are otherwise unchanged from Phase 2 — the worker process picks up `MERGE` jobs the same way it already picks up `VALIDATE_TRANSCRIPT` jobs.

## Locked Decisions

1. **Slice boundary** — Phase 3 stops at `DETECTING_CONFLICTS`'s entry; `ConflictDetector` is a later phase.
2. **Merger is stubbed**, not a real LLM call, same as Phase 2's locked decision for `TranscriptQualityChecker`.
3. **Merger's confidence varies with notes-presence** (0.92 with notes, 0.65 without) rather than being fixed like Phase 2's stub — this makes both the auto-approve and low-confidence Gateway paths reachable live via the API, without the temporary policy edit Phase 2's own manual-verification checklist needed.
4. **Retry/edit-retry activate generically** at `PENDING_HUMAN_CONFIRMATION` for every registered skill, not just `Merger` — one mechanism, resolved per-episode via the checkpoint's own `ai_output.skillName`.
5. **`attempt_number` is computed inside `handleSkillOutput()`** from the referenced prior output (`+1`), not stored as a separate `Job` column — keeps the `jobs` migration to two columns.
6. **`approval_requests.attemptCount` is seeded from the computed `attempt_number`** at creation, so it accumulates correctly across a chain of resolved episodes and `max_retries` enforcement is meaningful.
7. **Max-retries check** blocks retry/edit-retry once `attemptCount >= maxRetries` (default 5) → 409. One shared budget across retry and edit-retry, not two separate counters.
8. **Auto-enqueue is generalized** via a `WorkflowState → JobType` map derived from `SKILL_ROUTING`, keyed off each transition's actual resulting state — this is also what will let a future `ConflictDetector` start automatically, by adding one `SKILL_ROUTING` entry with no further gateway changes.
9. **`MERGE` jobs never set `Job.inputRef`** — `mergeRunner.ts` always resolves the latest transcript/notes at run time; `ai_output_inputs` (populated for Merger only this phase) is the authoritative lineage record instead.
10. **`merges` is versioned per attempt**, written by `mergeRunner.ts` rather than `gateway.ts`, so the Gateway never needs to know a skill's result shape.
11. **Test files run sequentially** (`vitest.config.ts`'s `fileParallelism: false`), added this phase. The suite shares one Postgres database, including genuinely global tables (`approval_policies`, the `jobs` queue) that Phase 3's tests are the first to mutate temporarily mid-test (max-retries and retry-lineage scenarios) — unsafe under file-level parallelism, so files were serialized instead of redesigning the tests.
