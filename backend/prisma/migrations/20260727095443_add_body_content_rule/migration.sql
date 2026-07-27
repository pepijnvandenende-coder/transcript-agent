/*
  Warnings:

  - Added the required column `body_content_rule` to the `report_type_policies` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "report_type_policies" ADD COLUMN     "body_content_rule" JSONB;

-- Backfill existing catalog rows (thematic/qa) so the column can become
-- required; new rows going forward set this explicitly via seed.ts.
UPDATE "report_type_policies" SET "body_content_rule" = '{"type":"topic_sections","minCount":1}'::jsonb WHERE "key" = 'thematic';
UPDATE "report_type_policies" SET "body_content_rule" = '{"type":"qa_pairs","minCount":1}'::jsonb WHERE "key" = 'qa';
UPDATE "report_type_policies" SET "body_content_rule" = '{"type":"topic_sections","minCount":1}'::jsonb WHERE "body_content_rule" IS NULL;

ALTER TABLE "report_type_policies" ALTER COLUMN "body_content_rule" SET NOT NULL;
