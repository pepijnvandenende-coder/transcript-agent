-- CreateTable
CREATE TABLE "draft_prechecks" (
    "id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "draft_id" TEXT NOT NULL,
    "ai_output_id" TEXT NOT NULL,
    "overall_score" DOUBLE PRECISION NOT NULL,
    "checklist" JSONB NOT NULL,
    "blocking_issues" JSONB NOT NULL,
    "recommendation" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "draft_prechecks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_feedback" (
    "id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "draft_id" TEXT NOT NULL,
    "feedback" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_feedback_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "draft_prechecks" ADD CONSTRAINT "draft_prechecks_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_prechecks" ADD CONSTRAINT "draft_prechecks_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "drafts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "draft_prechecks" ADD CONSTRAINT "draft_prechecks_ai_output_id_fkey" FOREIGN KEY ("ai_output_id") REFERENCES "ai_outputs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_feedback" ADD CONSTRAINT "review_feedback_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_feedback" ADD CONSTRAINT "review_feedback_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "drafts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_feedback" ADD CONSTRAINT "review_feedback_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
