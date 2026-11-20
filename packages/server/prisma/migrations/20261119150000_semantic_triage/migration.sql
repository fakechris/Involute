CREATE TABLE "SemanticTriageExposure" (
    "id" UUID NOT NULL,
    "workId" UUID NOT NULL,
    "observationId" TEXT NOT NULL,
    "actorId" UUID NOT NULL,
    "exposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SemanticTriageExposure_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SemanticTriageExposure_observationId_actorId_key" ON "SemanticTriageExposure"("observationId", "actorId");
CREATE INDEX "SemanticTriageExposure_workId_idx" ON "SemanticTriageExposure"("workId");

CREATE TABLE "SemanticTriageCorrection" (
    "id" UUID NOT NULL,
    "workId" UUID NOT NULL,
    "observationId" TEXT NOT NULL,
    "actorId" UUID NOT NULL,
    "checkId" TEXT NOT NULL,
    "verdict" TEXT NOT NULL CHECK ("verdict" IN ('accepted', 'corrected', 'rejected')),
    "originalValue" TEXT NOT NULL,
    "correctedValue" TEXT,
    "note" TEXT,
    "exposedAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL,
    "handlingMs" INTEGER NOT NULL CHECK ("handlingMs" >= 0),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SemanticTriageCorrection_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SemanticTriageCorrection_workId_actorId_checkId_decidedAt_idx" ON "SemanticTriageCorrection"("workId", "actorId", "checkId", "decidedAt");
