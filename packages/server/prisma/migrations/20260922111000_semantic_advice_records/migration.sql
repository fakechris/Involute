CREATE TABLE "SemanticAdviceRecord" (
    "key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SemanticAdviceRecord_pkey" PRIMARY KEY ("key")
);
