-- Read-only upstream data, stored so the overview survives a GitHub outage.
ALTER TABLE "repositories"
  ADD COLUMN "stars" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "watchers" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "openIssues" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "language" TEXT,
  ADD COLUMN "licenseName" TEXT,
  ADD COLUMN "licenseSpdx" TEXT,
  ADD COLUMN "languagesJson" TEXT,
  ADD COLUMN "metadataSyncedAt" TIMESTAMP(3);
