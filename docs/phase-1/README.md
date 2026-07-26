# Phase 1 — Application Foundation

## Scope

Phase 1 delivers the foundation only: project structure, the database schema for the seven core/governance tables, the deterministic workflow engine (FSM), and five read/create/cancel API endpoints.

It deliberately does **not** include: frontend UI, AI calls, LLM integration, prompt logic, file uploads, authentication, or deployment configuration. See `docs/architecture/README.md` for the full design those will build on.

## Prerequisites

- Node.js 20+
- A local PostgreSQL instance (Phase 1 does not provide Docker/Compose for this — that's deployment configuration, out of scope for this phase)

## Setup

1. `cd backend`
2. `npm install`
3. Copy `.env.example` to `.env` and set `DATABASE_URL` to point at your local Postgres instance.
4. `npm run prisma:generate` — generates the Prisma client + TypeScript types from `prisma/schema.prisma`. Does not require a DB connection.
5. `npm run prisma:migrate` — creates and applies the initial migration under `prisma/migrations/`. Requires a reachable Postgres instance.

## Running

- `npm run dev` — starts the API server (default port 3000, override via `PORT` in `.env`).
- `npm run typecheck` — type-checks the whole project.

## Testing

- `npm test` runs the full suite.
- `tests/workflow/transitions.test.ts` is pure logic — no database needed. It validates the transition table's integrity (no duplicate rules, every non-terminal state has an outgoing edge, cancel is reachable from everywhere) and the guard lookup function.
- `tests/workflow/engine.test.ts` and `tests/workflow/auditTrail.test.ts` are integration tests against a real Postgres database — they require steps 3-5 above to be complete. Each test creates its own throwaway `User`/`Workflow` rows and removes the user it created in `afterAll`.

## API surface delivered in this phase

| Method | Path | Purpose |
|---|---|---|
| POST | `/workflows` | Create a workflow (enters at `CREATED`) |
| GET | `/workflows/:id` | Full workflow detail ("get workflow status") |
| GET | `/workflows/:id/state` | Current state + valid user actions ("get allowed actions") |
| GET | `/workflows/:id/history` | Full audit trail (`state_transitions`) for the workflow |
| POST | `/workflows/:id/cancel` | Cancel — valid from any non-terminal state |

## Known Phase 1 simplification

There is no auth yet, so `createdById` (on create) and `actorId` (on cancel) must reference an existing `users.id`, supplied directly by the caller. Create a `User` row via `npx prisma studio` or a one-off script until a real auth layer and Users API exist.
