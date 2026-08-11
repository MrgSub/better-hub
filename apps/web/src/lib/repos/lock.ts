import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";

/**
 * Serialising the writes that move a repository's refs.
 *
 * The work being guarded is git backend calls, so the guard must not be an
 * open database transaction: that would hold a connection for the length of a
 * remote round trip, and rolling back could not un-move a ref the backend
 * already moved. Instead the holder takes a short lease row — one atomic
 * statement, no transaction outlives it — and gives it back when done. A
 * process that dies mid-merge is covered by the lease expiring rather than by
 * anything having to notice.
 *
 * The lease is a scheduling device, not the safety net: correctness rests on
 * the caller passing the base sha it expects, so a write that outlives its
 * lease is still refused by the backend rather than landing on a tree nobody
 * reviewed.
 */

/** Long enough for a merge and its restack walk, short enough to recover. */
const LEASE_MS = 120_000;
const RETRY_DELAY_MS = 250;
const ACQUIRE_TIMEOUT_MS = 30_000;

export class RepoBusyError extends Error {
	constructor(repositoryId: string) {
		super(`Another write to ${repositoryId} is in progress — try again`);
		this.name = "RepoBusyError";
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Takes the lease if it is free or expired. One statement, so two callers
 * racing it cannot both win: the loser updates zero rows.
 */
async function tryAcquire(repositoryId: string, holder: string): Promise<boolean> {
	const expiresAt = new Date(Date.now() + LEASE_MS);
	const rows = await prisma.$executeRaw`
		INSERT INTO "repository_locks" ("repositoryId", "holder", "expiresAt", "acquiredAt")
		VALUES (${repositoryId}, ${holder}, ${expiresAt}, NOW())
		ON CONFLICT ("repositoryId") DO UPDATE
		SET "holder" = ${holder}, "expiresAt" = ${expiresAt}, "acquiredAt" = NOW()
		WHERE "repository_locks"."expiresAt" < NOW()
	`;
	return rows > 0;
}

/** Only the holder releases, so a lease that already expired and was taken by
 * someone else is left alone. */
async function release(repositoryId: string, holder: string): Promise<void> {
	await prisma.$executeRaw`
		DELETE FROM "repository_locks"
		WHERE "repositoryId" = ${repositoryId} AND "holder" = ${holder}
	`;
}

export async function withRepoLock<T>(repositoryId: string, run: () => Promise<T>): Promise<T> {
	const holder = randomUUID();
	const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;

	while (!(await tryAcquire(repositoryId, holder))) {
		if (Date.now() >= deadline) throw new RepoBusyError(repositoryId);
		await sleep(RETRY_DELAY_MS);
	}

	try {
		return await run();
	} finally {
		await release(repositoryId, holder).catch(() => {});
	}
}
