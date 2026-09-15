ALTER TABLE "WorkRun"
 ADD COLUMN "contractRevision" TEXT,
 ADD COLUMN "acceptanceDigest" TEXT,
 ADD COLUMN "contractSnapshot" JSONB,
 ADD COLUMN "claimSnapshotId" UUID,
 ADD COLUMN "repository" TEXT,
 ADD COLUMN "commitSha" TEXT,
 ADD COLUMN "pullRequestNumber" INTEGER;
ALTER TABLE "WorkEvidence" ADD COLUMN "verificationNextAt" TIMESTAMP(3), ADD COLUMN "verificationLeaseId" UUID, ADD COLUMN "verificationLeaseUntil" TIMESTAMP(3);
CREATE INDEX "WorkEvidence_verificationNextAt_idx" ON "WorkEvidence"("verificationNextAt");
CREATE TYPE "EvidenceVerificationStatus" AS ENUM ('PENDING','VERIFIED','FAILED','UNAVAILABLE','STALE');
CREATE TABLE "EvidenceVerification" (
 "id" UUID NOT NULL,
 "evidenceId" UUID NOT NULL,
 "verifierId" TEXT NOT NULL,
 "verifierVersion" TEXT NOT NULL,
 "status" "EvidenceVerificationStatus" NOT NULL,
 "repository" TEXT,
 "commitSha" TEXT,
 "externalRunId" TEXT,
 "contractRevision" TEXT,
 "acceptanceDigest" TEXT,
 "runId" UUID,
 "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "resultDigest" TEXT NOT NULL,
 "failureCode" TEXT,
 "result" JSONB NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "EvidenceVerification_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "EvidenceVerification_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "WorkEvidence"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "EvidenceVerification_evidenceId_createdAt_idx" ON "EvidenceVerification"("evidenceId","createdAt");
