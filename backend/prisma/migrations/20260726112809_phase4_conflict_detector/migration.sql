-- CreateEnum
CREATE TYPE "ConflictStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateTable
CREATE TABLE "conflicts" (
    "id" TEXT NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "ai_output_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "source_a" TEXT,
    "source_b" TEXT,
    "status" "ConflictStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conflicts_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_ai_output_id_fkey" FOREIGN KEY ("ai_output_id") REFERENCES "ai_outputs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
