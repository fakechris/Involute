-- INV-1503 / decision INV-1501: field definitions and Issue.attributes (docs/field-definitions.md).
CREATE TYPE "FieldType" AS ENUM ('TEXT', 'NUMBER', 'BOOLEAN', 'DATE', 'ENUM', 'MULTI_ENUM', 'WORK_REF', 'USER_REF', 'URL');

CREATE TABLE "FieldDefinition" (
    "id" UUID NOT NULL,
    "scope" "AutonomyScope" NOT NULL,
    "scopeId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "type" "FieldType" NOT NULL,
    "options" JSONB,
    "appliesTo" JSONB NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "defaultValue" JSONB,
    "searchable" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "reason" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FieldDefinition_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FieldDefinition_scope_scopeId_active_idx" ON "FieldDefinition"("scope", "scopeId", "active");
CREATE INDEX "FieldDefinition_key_idx" ON "FieldDefinition"("key");
-- One active definition per key within a scope.
CREATE UNIQUE INDEX "FieldDefinition_active_key" ON "FieldDefinition"("scope", "scopeId", "key") WHERE "active";

ALTER TABLE "Issue" ADD COLUMN "attributes" JSONB NOT NULL DEFAULT '{}';
-- Default tier: equality / containment on every field without per-field DDL.
CREATE INDEX "Issue_attributes_gin" ON "Issue" USING GIN ("attributes" jsonb_path_ops);
