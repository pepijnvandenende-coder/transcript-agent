-- AlterEnum
-- Postgres requires a new enum value to be committed before it can be used
-- (e.g. as a column DEFAULT) -- see the follow-up migration for that part.
ALTER TYPE "WorkflowState" ADD VALUE 'CONTEXT_INPUT';
