-- Devin's API is scoped to an organization, so a key alone cannot address it.
ALTER TABLE "agent_connections" ADD COLUMN "accountId" TEXT;
