-- A verified conflict resolution held for a human to merge.
ALTER TABLE "pull_requests" ADD COLUMN "resolutionBranch" TEXT;
ALTER TABLE "pull_requests" ADD COLUMN "resolutionSha" TEXT;
ALTER TABLE "pull_requests" ADD COLUMN "resolutionBy" TEXT;
