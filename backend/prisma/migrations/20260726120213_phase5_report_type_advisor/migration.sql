-- CreateTable
CREATE TABLE "report_type_suggestions" (
    "id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "ai_output_id" TEXT NOT NULL,
    "suggested_type" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "runner_up" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_type_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "report_type_suggestions_workflow_id_version_key" ON "report_type_suggestions"("workflow_id", "version");

-- AddForeignKey
ALTER TABLE "report_type_suggestions" ADD CONSTRAINT "report_type_suggestions_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_type_suggestions" ADD CONSTRAINT "report_type_suggestions_ai_output_id_fkey" FOREIGN KEY ("ai_output_id") REFERENCES "ai_outputs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
