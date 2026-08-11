-- Lease-based serialisation for ref-moving writes, so the guard does not need
-- an open transaction while the git backend is being called.
CREATE TABLE "repository_locks" (
    "repositoryId" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repository_locks_pkey" PRIMARY KEY ("repositoryId")
);
