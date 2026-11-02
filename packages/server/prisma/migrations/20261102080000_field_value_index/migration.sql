-- INV-1504: FieldValueIndex for searchable fields, rename alias, usage and index job state.
CREATE TYPE "FieldIndexJob" AS ENUM ('BACKFILL', 'CLEANUP');

ALTER TABLE "FieldDefinition" ADD COLUMN "previousKey" TEXT;
ALTER TABLE "FieldDefinition" ADD COLUMN "lastWrittenAt" TIMESTAMP(3);
ALTER TABLE "FieldDefinition" ADD COLUMN "indexJob" "FieldIndexJob";
ALTER TABLE "FieldDefinition" ADD COLUMN "indexCursor" TEXT;
ALTER TABLE "FieldDefinition" ADD COLUMN "indexProcessed" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "FieldDefinition_indexJob_idx" ON "FieldDefinition"("indexJob");

CREATE TABLE "FieldValueIndex" (
    "id" UUID NOT NULL,
    "issueId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "textValue" TEXT,
    "numberValue" DOUBLE PRECISION,
    "dateValue" TIMESTAMP(3),
    "refId" UUID,
    CONSTRAINT "FieldValueIndex_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FieldValueIndex_key_textValue_idx" ON "FieldValueIndex"("key", "textValue");
CREATE INDEX "FieldValueIndex_key_numberValue_idx" ON "FieldValueIndex"("key", "numberValue");
CREATE INDEX "FieldValueIndex_key_dateValue_idx" ON "FieldValueIndex"("key", "dateValue");
CREATE INDEX "FieldValueIndex_key_refId_idx" ON "FieldValueIndex"("key", "refId");
CREATE INDEX "FieldValueIndex_issueId_idx" ON "FieldValueIndex"("issueId");
ALTER TABLE "FieldValueIndex" ADD CONSTRAINT "FieldValueIndex_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
