-- Repository metadata so a hosted repo's overview needs no GitHub call.
ALTER TABLE "repositories"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "homepage" TEXT,
  ADD COLUMN "topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "isPrivate" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sizeKb" INTEGER NOT NULL DEFAULT 0;
