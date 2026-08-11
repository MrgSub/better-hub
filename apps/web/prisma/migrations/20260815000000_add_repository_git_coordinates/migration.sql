-- The coordinates the git backend knows a repository by, so a rename here does
-- not move the repository the backend is asked for. Existing rows have never
-- been renamed, so their display coordinates are still the backend's.
ALTER TABLE "repositories"
  ADD COLUMN "gitOwner" TEXT,
  ADD COLUMN "gitName" TEXT;

UPDATE "repositories"
SET "gitOwner" = split_part("gitRepoId", '/', 1),
    "gitName" = split_part("gitRepoId", '/', 2)
WHERE "gitRepoId" LIKE '%/%';

UPDATE "repositories"
SET "gitOwner" = "owner", "gitName" = "name"
WHERE "gitOwner" IS NULL OR "gitName" IS NULL;

ALTER TABLE "repositories"
  ALTER COLUMN "gitOwner" SET NOT NULL,
  ALTER COLUMN "gitName" SET NOT NULL;
