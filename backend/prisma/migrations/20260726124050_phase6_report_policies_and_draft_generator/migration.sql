-- CreateTable
CREATE TABLE "report_type_policies" (
    "key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'nl',
    "prompt_version" TEXT NOT NULL,
    "prompt_ref" TEXT NOT NULL,
    "required_sections" JSONB NOT NULL,
    "optional_sections" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_type_policies_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "drafts" (
    "id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "ai_output_id" TEXT NOT NULL,
    "report_type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "attendees" JSONB NOT NULL,
    "date" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "sections" JSONB NOT NULL,
    "coverage" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "drafts_workflow_id_version_key" ON "drafts"("workflow_id", "version");

-- AddForeignKey
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_ai_output_id_fkey" FOREIGN KEY ("ai_output_id") REFERENCES "ai_outputs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
