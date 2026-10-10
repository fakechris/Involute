-- INV-1146: browser environment captured with a bug report, and the web
-- origins a PROJECT's app is served from (routing for the capture extension).
ALTER TABLE "Issue" ADD COLUMN "webOrigins" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "capture" JSONB;
