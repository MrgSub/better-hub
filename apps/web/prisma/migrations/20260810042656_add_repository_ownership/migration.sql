-- Repository ownership: who owns an imported repo, which GitHub upstream it
-- came from, and who may write to it. The unique index on the upstream triple
-- is what makes a second import of the same GitHub repo resolve to the
-- existing repository (or a fork) instead of a duplicate copy.
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "githubLogin" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "organization_members" (
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_members_pkey" PRIMARY KEY ("organizationId","userId")
);

CREATE TABLE "repositories" (
    "id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL,
    "gitBackend" TEXT NOT NULL,
    "gitRepoId" TEXT NOT NULL,
    "upstreamHost" TEXT,
    "upstreamOwner" TEXT,
    "upstreamName" TEXT,
    "forkOfId" TEXT,
    "ownerUserId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repositories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "repository_collaborators" (
    "repositoryId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repository_collaborators_pkey" PRIMARY KEY ("repositoryId","userId")
);

CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");
CREATE UNIQUE INDEX "organizations_githubLogin_key" ON "organizations"("githubLogin");
CREATE INDEX "organization_members_userId_idx" ON "organization_members"("userId");
CREATE INDEX "repositories_ownerUserId_idx" ON "repositories"("ownerUserId");
CREATE INDEX "repositories_organizationId_idx" ON "repositories"("organizationId");
CREATE UNIQUE INDEX "repositories_owner_name_key" ON "repositories"("owner", "name");
CREATE UNIQUE INDEX "repositories_upstreamHost_upstreamOwner_upstreamName_key" ON "repositories"("upstreamHost", "upstreamOwner", "upstreamName");
CREATE INDEX "repository_collaborators_userId_idx" ON "repository_collaborators"("userId");

ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "repositories" ADD CONSTRAINT "repositories_forkOfId_fkey" FOREIGN KEY ("forkOfId") REFERENCES "repositories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "repositories" ADD CONSTRAINT "repositories_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "repositories" ADD CONSTRAINT "repositories_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "repository_collaborators" ADD CONSTRAINT "repository_collaborators_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "repository_collaborators" ADD CONSTRAINT "repository_collaborators_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
