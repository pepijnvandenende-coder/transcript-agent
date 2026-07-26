-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "retry_mode" "RetryMode",
ADD COLUMN     "retry_of_ai_output_id" TEXT;

-- CreateTable
CREATE TABLE "merges" (
    "id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "ai_output_id" TEXT NOT NULL,
    "merged_sections" JSONB NOT NULL,
    "unmatched_notes" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "merges_workflow_id_version_key" ON "merges"("workflow_id", "version");

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_retry_of_ai_output_id_fkey" FOREIGN KEY ("retry_of_ai_output_id") REFERENCES "ai_outputs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merges" ADD CONSTRAINT "merges_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merges" ADD CONSTRAINT "merges_ai_output_id_fkey" FOREIGN KEY ("ai_output_id") REFERENCES "ai_outputs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
