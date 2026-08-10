-- Issues stay upstream, pull requests are ours, so one counter serves both.
ALTER TABLE "repositories" ADD COLUMN "nextNumber" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "pull_requests" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "bodyMd" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT 'open',
    "draft" BOOLEAN NOT NULL DEFAULT false,
    "headBranch" TEXT NOT NULL,
    "baseBranch" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "baseSha" TEXT NOT NULL,
    "mergeSha" TEXT,
    "additions" INTEGER NOT NULL DEFAULT 0,
    "deletions" INTEGER NOT NULL DEFAULT 0,
    "changedFiles" INTEGER NOT NULL DEFAULT 0,
    "parentId" TEXT,
    "stackId" TEXT,
    "authorId" TEXT NOT NULL,
    "authorLogin" TEXT,
    "authorName" TEXT,
    "authorAvatarUrl" TEXT,
    "mergedById" TEXT,
    "mergedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pull_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pull_request_reviews" (
    "id" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "reviewerLogin" TEXT,
    "reviewerName" TEXT,
    "reviewerAvatarUrl" TEXT,
    "state" TEXT NOT NULL,
    "bodyMd" TEXT NOT NULL DEFAULT '',
    "commitSha" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pull_request_reviews_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pull_request_comments" (
    "id" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorLogin" TEXT,
    "authorName" TEXT,
    "authorAvatarUrl" TEXT,
    "bodyMd" TEXT NOT NULL,
    "path" TEXT,
    "line" INTEGER,
    "side" TEXT,
    "commitSha" TEXT,
    "diffHunk" TEXT,
    "inReplyToId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pull_request_comments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pull_request_events" (
    "id" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payloadJson" TEXT,
    "actorId" TEXT,
    "actorLogin" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pull_request_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pull_requests_repositoryId_number_key" ON "pull_requests"("repositoryId", "number");
CREATE INDEX "pull_requests_repositoryId_state_idx" ON "pull_requests"("repositoryId", "state");
CREATE INDEX "pull_requests_stackId_idx" ON "pull_requests"("stackId");
CREATE INDEX "pull_request_reviews_pullRequestId_createdAt_idx" ON "pull_request_reviews"("pullRequestId", "createdAt");
CREATE INDEX "pull_request_comments_pullRequestId_createdAt_idx" ON "pull_request_comments"("pullRequestId", "createdAt");
CREATE INDEX "pull_request_events_pullRequestId_createdAt_idx" ON "pull_request_events"("pullRequestId", "createdAt");

ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "pull_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "pull_request_reviews" ADD CONSTRAINT "pull_request_reviews_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pull_request_comments" ADD CONSTRAINT "pull_request_comments_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pull_request_events" ADD CONSTRAINT "pull_request_events_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
