-- CreateEnum
CREATE TYPE "WorkflowState" AS ENUM ('CREATED', 'TRANSCRIPT_UPLOADED', 'VALIDATING_TRANSCRIPT', 'TRANSCRIPT_INSUFFICIENT', 'PENDING_HUMAN_CONFIRMATION', 'MERGING', 'DETECTING_CONFLICTS', 'CONFLICTS_PENDING_REVIEW', 'SUGGESTING_REPORT_TYPE', 'AWAITING_REPORT_TYPE_SELECTION', 'GENERATING_DRAFT', 'DRAFT_QUALITY_PRECHECK', 'DRAFT_PENDING_REVIEW', 'REVISING_DRAFT', 'GENERATING_FINAL', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "WorkflowStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JobType" AS ENUM ('VALIDATE_TRANSCRIPT', 'MERGE', 'DETECT_CONFLICTS', 'SUGGEST_REPORT_TYPE', 'GENERATE_DRAFT', 'DRAFT_QUALITY_PRECHECK', 'REVISE_DRAFT', 'RENDER_FINAL');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "ValidationStatus" AS ENUM ('VALID', 'INVALID');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'AUTO_APPROVED', 'HUMAN_APPROVED', 'HUMAN_REJECTED');

-- CreateEnum
CREATE TYPE "PolicyType" AS ENUM ('AUTO_IF_ABOVE', 'MANDATORY', 'ADVISORY_ONLY');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('SYSTEM', 'USER');

-- CreateEnum
CREATE TYPE "RetryMode" AS ENUM ('SAME_INPUT', 'EDITED_INPUT');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflows" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "current_state" "WorkflowState" NOT NULL DEFAULT 'CREATED',
    "report_type" TEXT,
    "status" "WorkflowStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_transitions" (
    "id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "from_state" "WorkflowState",
    "to_state" "WorkflowState" NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" TEXT,
    "ai_output_id" TEXT,
    "metadata" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "state_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "job_type" "JobType" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "input_ref" TEXT,
    "output_ref" TEXT,
    "error" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "result_ai_output_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_outputs" (
    "id" TEXT NOT NULL,
    "job_id" TEXT,
    "workflow_id" TEXT NOT NULL,
    "skill_name" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "schema_version" TEXT NOT NULL,
    "raw_output" JSONB NOT NULL,
    "validation_status" "ValidationStatus" NOT NULL,
    "validation_errors" JSONB,
    "confidence_score" DOUBLE PRECISION,
    "confidence_breakdown" JSONB,
    "policy_applied" "PolicyType",
    "approval_status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "approval_request_id" TEXT,
    "attempt_number" INTEGER NOT NULL DEFAULT 1,
    "retry_of_ai_output_id" TEXT,
    "retry_mode" "RetryMode",
    "reviewer_comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_outputs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_policies" (
    "skill_name" TEXT NOT NULL,
    "policy_type" "PolicyType" NOT NULL,
    "confidence_threshold" DOUBLE PRECISION,
    "max_retries" INTEGER DEFAULT 5,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_policies_pkey" PRIMARY KEY ("skill_name")
);

-- CreateTable
CREATE TABLE "skill_registry" (
    "skill_name" TEXT NOT NULL,
    "current_prompt_version" TEXT NOT NULL,
    "current_schema_version" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "skill_registry_pkey" PRIMARY KEY ("skill_name")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_result_ai_output_id_key" ON "jobs"("result_ai_output_id");

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "state_transitions" ADD CONSTRAINT "state_transitions_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "state_transitions" ADD CONSTRAINT "state_transitions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "state_transitions" ADD CONSTRAINT "state_transitions_ai_output_id_fkey" FOREIGN KEY ("ai_output_id") REFERENCES "ai_outputs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_result_ai_output_id_fkey" FOREIGN KEY ("result_ai_output_id") REFERENCES "ai_outputs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_outputs" ADD CONSTRAINT "ai_outputs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_outputs" ADD CONSTRAINT "ai_outputs_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_outputs" ADD CONSTRAINT "ai_outputs_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_outputs" ADD CONSTRAINT "ai_outputs_retry_of_ai_output_id_fkey" FOREIGN KEY ("retry_of_ai_output_id") REFERENCES "ai_outputs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
