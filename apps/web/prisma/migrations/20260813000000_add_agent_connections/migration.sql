-- CreateTable
CREATE TABLE "agent_connections" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'model',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "apiKeyEnc" TEXT,
    "connectedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_connections_organizationId_key" ON "agent_connections"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_connections_userId_key" ON "agent_connections"("userId");

-- AddForeignKey
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
