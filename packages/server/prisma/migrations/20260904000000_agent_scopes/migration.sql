ALTER TABLE "AgentCredential" ADD COLUMN "scopes" TEXT[] NOT NULL DEFAULT ARRAY['read', 'propose', 'claim', 'report', 'update', 'link'];
