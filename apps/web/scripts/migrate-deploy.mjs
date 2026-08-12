/**
 * Applies pending migrations before the build that needs them.
 *
 * Only production builds migrate: a preview deployment usually inherits the
 * production `DATABASE_URL`, so migrating from one would change production
 * ahead of the code that expects it. Without a database configured — a CI
 * typecheck, a local build — this is a no-op rather than a failure.
 */
import { spawnSync } from "node:child_process";

const vercelEnv = process.env.VERCEL_ENV;

if (!process.env.DATABASE_URL) {
	console.log("migrate: no DATABASE_URL, skipping");
	process.exit(0);
}

if (vercelEnv && vercelEnv !== "production") {
	console.log(`migrate: VERCEL_ENV=${vercelEnv}, skipping`);
	process.exit(0);
}

const result = spawnSync("prisma", ["migrate", "deploy"], { stdio: "inherit" });
process.exit(result.status ?? 1);
