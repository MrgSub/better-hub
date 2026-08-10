-- `githubLogin` is written on every OAuth sign-up and PAT sign-in but was never
-- added to the schema; `stripeCustomerId` was added to the schema without a
-- migration. IF NOT EXISTS keeps this a no-op on databases that already drifted
-- into having them.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "githubLogin" TEXT;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "stripeCustomerId" TEXT;
