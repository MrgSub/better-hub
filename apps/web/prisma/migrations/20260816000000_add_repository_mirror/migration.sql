-- Whether the git backend forwards the refs we write to the GitHub upstream,
-- and what its last sync run did. Existing rows were imported before mirroring
-- existed, so none of them forwards anything.
ALTER TABLE "repositories"
  ADD COLUMN "mirrorMode" TEXT NOT NULL DEFAULT 'off',
  ADD COLUMN "mirrorState" TEXT,
  ADD COLUMN "mirrorError" TEXT,
  ADD COLUMN "mirrorSyncedAt" TIMESTAMP(3);
