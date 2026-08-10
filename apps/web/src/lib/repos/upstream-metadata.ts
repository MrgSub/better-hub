import { Octokit } from "@octokit/rest";
import { waitUntil } from "@vercel/functions";
import type { Repository } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { redis } from "@/lib/redis";

/**
 * Read-only data GitHub still owns for an imported repository — stars,
 * watchers, language breakdown, licence, and the settings people edit over
 * there. We copy it onto the row rather than reading it per request, so the
 * overview renders the last known values when GitHub is unreachable.
 */

const REFRESH_AFTER_MS = 60 * 60 * 1000;
const STARRED_TTL_SECONDS = 60 * 60;

export interface UpstreamCoordinates {
	owner: string;
	repo: string;
}

/** Where a repository's read-only data lives; null once nothing is upstream. */
export function upstreamCoordinates(record: Repository): UpstreamCoordinates | null {
	if (record.upstreamHost !== "github.com" || !record.upstreamOwner || !record.upstreamName) {
		return null;
	}
	return { owner: record.upstreamOwner, repo: record.upstreamName };
}

export function isMetadataStale(record: Repository, now = Date.now()): boolean {
	if (!record.metadataSyncedAt) return true;
	return now - record.metadataSyncedAt.getTime() > REFRESH_AFTER_MS;
}

export function parseLanguages(record: Repository): Record<string, number> {
	if (!record.languagesJson) return {};
	try {
		return JSON.parse(record.languagesJson) as Record<string, number>;
	} catch {
		return {};
	}
}

/**
 * Copies the upstream's read-only data onto the row. Best effort: a failure
 * leaves the previous values in place, which is the whole point of storing
 * them.
 */
export async function syncUpstreamMetadata(
	record: Repository,
	token: string,
): Promise<Repository | null> {
	const upstream = upstreamCoordinates(record);
	if (!upstream) return null;

	const octokit = new Octokit({ auth: token });
	try {
		const [repo, languages] = await Promise.all([
			octokit.repos.get({ ...upstream }),
			octokit.repos.listLanguages({ ...upstream }).then(
				(r) => r.data,
				() => null,
			),
		]);
		const data = repo.data;

		return await prisma.repository.update({
			where: { id: record.id },
			data: {
				description: data.description,
				homepage: data.homepage || null,
				topics: data.topics ?? [],
				isPrivate: data.private,
				archived: data.archived,
				sizeKb: data.size,
				stars: data.stargazers_count,
				watchers: data.subscribers_count ?? data.watchers_count,
				openIssues: data.open_issues_count,
				language: data.language ?? null,
				licenseName: data.license?.name ?? null,
				licenseSpdx: data.license?.spdx_id ?? null,
				...(languages ? { languagesJson: JSON.stringify(languages) } : {}),
				metadataSyncedAt: new Date(),
			},
		});
	} catch {
		return null;
	}
}

function starredKey(userId: string, upstream: UpstreamCoordinates): string {
	return `gh:starred:${userId}:${upstream.owner}/${upstream.repo}`;
}

/** Whether the viewer starred the upstream; false when GitHub can't say. */
async function readUpstreamStarred(upstream: UpstreamCoordinates, token: string): Promise<boolean> {
	try {
		await new Octokit({ auth: token }).activity.checkRepoIsStarredByAuthenticatedUser({
			...upstream,
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * The viewer's star, from cache. A miss answers false and refreshes in the
 * background, so rendering a hosted page never waits on GitHub.
 */
export async function cachedUpstreamStarred(
	record: Repository,
	userId: string | null,
	token: string,
): Promise<boolean> {
	const upstream = upstreamCoordinates(record);
	if (!upstream || !userId) return false;

	const key = starredKey(userId, upstream);
	const cached = await redis.get<number>(key).catch(() => null);
	if (cached !== null && cached !== undefined) return cached === 1;

	waitUntil(
		readUpstreamStarred(upstream, token).then((starred) =>
			redis.set(key, starred ? 1 : 0, { ex: STARRED_TTL_SECONDS }),
		),
	);
	return false;
}

/** Records the star the user just made, so the next render agrees with them. */
export async function setUpstreamStarred(
	record: Repository,
	userId: string,
	starred: boolean,
): Promise<void> {
	const upstream = upstreamCoordinates(record);
	if (!upstream) return;
	await redis.set(starredKey(userId, upstream), starred ? 1 : 0, { ex: STARRED_TTL_SECONDS });
}
