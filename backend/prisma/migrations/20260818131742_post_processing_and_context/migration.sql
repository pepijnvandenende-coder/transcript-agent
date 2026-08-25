-- CreateEnum
CREATE TYPE "PostProcessingResultStatus" AS ENUM ('COMPLETED', 'FAILED', 'SKIPPED');

-- AlterEnum
ALTER TYPE "JobType" ADD VALUE 'RUN_POST_PROCESSING';

-- AlterEnum
ALTER TYPE "WorkflowState" ADD VALUE 'POST_PROCESSING';

-- CreateTable
CREATE TABLE "context_items" (
    "id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "context_type" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "storage_ref" TEXT NOT NULL,
    "uploaded_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "context_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "context_type_policies" (
    "key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "description" TEXT,
    "instruction_label" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "context_type_policies_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "post_processing_skill_policies" (
    "key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "description" TEXT,
    "prompt_ref" TEXT NOT NULL,
    "requires_context_type" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "post_processing_skill_policies_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "post_processing_results" (
    "id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "skill_key" TEXT NOT NULL,
    "status" "PostProcessingResultStatus" NOT NULL,
    "ai_output_id" TEXT,
    "result_json" JSONB,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_processing_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "context_items_workflow_id_context_type_version_key" ON "context_items"("workflow_id", "context_type", "version");

-- AddForeignKey
ALTER TABLE "context_items" ADD CONSTRAINT "context_items_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "context_items" ADD CONSTRAINT "context_items_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_processing_results" ADD CONSTRAINT "post_processing_results_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_processing_results" ADD CONSTRAINT "post_processing_results_ai_output_id_fkey" FOREIGN KEY ("ai_output_id") REFERENCES "ai_outputs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
