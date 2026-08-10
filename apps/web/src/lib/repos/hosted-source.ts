import { waitUntil } from "@vercel/functions";
import { cache } from "react";
import type { Repository } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { getGitProvider, type GitBackend } from "@/lib/git";
import type { GitProvider } from "@/lib/git/provider";
import type { RepoRef } from "@/lib/git/types";
import type { RepoPageData } from "@/lib/github";
import type { UpstreamPermission } from "./policy";
import { findRepository, repositoryPermission } from "./registry";
import {
	cachedUpstreamStarred,
	isMetadataStale,
	parseLanguages,
	setUpstreamStarred,
	syncUpstreamMetadata,
	upstreamCoordinates,
} from "./upstream-metadata";

/**
 * Serves code reads from the repository's own git backend instead of GitHub.
 *
 * Payloads keep the GitHub REST shapes `lib/github.ts` already returns so the
 * pages rendering them stay untouched: the only difference is where the bytes
 * came from, which is what keeps browsing alive during a GitHub outage.
 */

export interface HostedRepo {
	ref: RepoRef;
	git: GitProvider;
	defaultBranch: string;
	record: Repository;
}

/**
 * Resolves a repository we host, or null when GitHub is still its home.
 * Cached per request because every code read asks first.
 */
export const hostedRepo = cache(async (owner: string, name: string): Promise<HostedRepo | null> => {
	const record = await findRepository(owner, name);
	if (!record) return null;
	return {
		ref: { owner: record.owner, repo: record.name },
		git: getGitProvider(record.gitBackend as GitBackend),
		defaultBranch: record.defaultBranch,
		record,
	};
});

/**
 * Tip of the default branch. Cached per request because both the overview and
 * the emptiness check below need it, and `hostedRepo` hands out a stable value.
 */
const hostedHead = cache(async (h: HostedRepo): Promise<RepoPageData["latestCommit"]> => {
	const page = await h.git.listCommits(h.ref, { branch: h.defaultBranch, limit: 1 });
	const head = page.items[0];
	if (!head) return null;
	return {
		sha: head.sha,
		message: head.message.split("\n")[0] ?? "",
		date: head.date,
		author: { login: head.author.name, avatarUrl: "" },
	};
});

function grantsOf(permission: UpstreamPermission | null) {
	return {
		admin: permission === "admin",
		maintain: permission === "admin",
		push: permission === "admin" || permission === "write",
		triage: permission === "admin" || permission === "write",
		pull: true,
	};
}

/**
 * Everything the overview needs about the repository itself, from our own
 * record plus the backend — no GitHub call, so it survives their outages.
 * Shaped like the REST payload `repos.get` returns, which is a superset of
 * what `RepoPageData.repoData` declares.
 */
export async function hostedRepoData(h: HostedRepo, permission: UpstreamPermission | null) {
	const { record } = h;
	const [head, parent] = await Promise.all([
		hostedHead(h),
		record.forkOfId
			? prisma.repository.findUnique({ where: { id: record.forkOfId } })
			: null,
	]);
	const upstreamUrl =
		record.upstreamHost && record.upstreamOwner && record.upstreamName
			? `https://${record.upstreamHost}/${record.upstreamOwner}/${record.upstreamName}`
			: null;

	return {
		id: record.id,
		node_id: record.id,
		name: record.name,
		full_name: `${record.owner}/${record.name}`,
		description: record.description ?? undefined,
		topics: record.topics,
		homepage: record.homepage,
		private: record.isPrivate,
		archived: record.archived,
		disabled: false,
		fork: record.forkOfId !== null,
		language: record.language,
		license: record.licenseName
			? { name: record.licenseName, spdx_id: record.licenseSpdx }
			: null,
		default_branch: record.defaultBranch,
		// The pages read this only to tell an empty repository from a populated
		// one, so a repo with a commit must never report zero.
		size: record.sizeKb || (head ? 1 : 0),
		stargazers_count: record.stars,
		watchers_count: record.stars,
		subscribers_count: record.watchers,
		forks_count: await prisma.repository.count({ where: { forkOfId: record.id } }),
		open_issues_count: record.openIssues,
		has_discussions: false,
		created_at: record.createdAt.toISOString(),
		updated_at: record.updatedAt.toISOString(),
		pushed_at: head?.date ?? record.updatedAt.toISOString(),
		html_url: upstreamUrl ?? `/${record.owner}/${record.name}`,
		owner: {
			login: record.owner,
			avatar_url: `https://github.com/${record.owner}.png`,
			type: record.organizationId ? "Organization" : "User",
		},
		permissions: grantsOf(permission),
		parent: parent
			? {
					full_name: `${parent.owner}/${parent.name}`,
					owner: { login: parent.owner },
					name: parent.name,
				}
			: null,
	};
}

/**
 * The repository page bundle GitHub answers with one GraphQL call. Counts that
 * belong to collaboration data we have not migrated yet are zero rather than
 * guessed.
 */
export async function hostedPageData(
	h: HostedRepo,
	viewer: { userId: string | null; login: string | null; token?: string },
): Promise<RepoPageData> {
	// Read-only upstream data is refreshed in the background: the page renders
	// the stored copy, so GitHub being slow or down costs nothing here.
	if (viewer.token && isMetadataStale(h.record)) {
		waitUntil(syncUpstreamMetadata(h.record, viewer.token));
	}

	const [permission, starred] = await Promise.all([
		repositoryPermission(h.record, viewer.userId),
		viewer.token ? cachedUpstreamStarred(h.record, viewer.userId, viewer.token) : false,
	]);
	const [repoData, latestCommit] = await Promise.all([
		hostedRepoData(h, permission),
		hostedHead(h),
	]);
	return {
		repoData,
		// Issues still live upstream, so their count is the copied one; pull
		// requests become ours, so theirs stays zero until that table exists.
		navCounts: {
			openPrs: 0,
			openIssues: h.record.openIssues,
			activeRuns: 0,
			discussions: 0,
		},
		languages: parseLanguages(h.record),
		viewerLogin: viewer.login,
		viewerHasStarred: starred,
		viewerIsOrgMember: h.record.organizationId !== null && permission !== null,
		latestCommit,
	};
}

/**
 * Where a write against GitHub has to land. Repositories we host keep their
 * read-only data upstream, so stars and the like target the upstream repo
 * rather than our (non-existent on GitHub) coordinates.
 */
export async function githubCoordinates(owner: string, repo: string): Promise<RepoRef> {
	const hosted = await hostedRepo(owner, repo);
	const upstream = hosted && upstreamCoordinates(hosted.record);
	return upstream ? { owner: upstream.owner, repo: upstream.repo } : { owner, repo };
}

/**
 * Records a star the user just made against the upstream and forces the next
 * page load to re-copy the counts it changed.
 */
export async function recordUpstreamStar(
	owner: string,
	repo: string,
	userId: string,
	starred: boolean,
): Promise<void> {
	const hosted = await hostedRepo(owner, repo);
	if (!hosted) return;
	await Promise.all([
		setUpstreamStarred(hosted.record, userId, starred),
		prisma.repository.update({
			where: { id: hosted.record.id },
			data: { metadataSyncedAt: null },
		}),
	]);
}

/** First README-ish file at the root, read through the backend. */
export async function hostedReadme(h: HostedRepo, ref?: string) {
	const at = ref || h.defaultBranch;
	const entries = await h.git.listFiles(h.ref, at, { path: "" });
	const readme = entries.find(
		(e) => e.type === "blob" && e.path.toLowerCase().startsWith("readme"),
	);
	if (!readme) return null;
	return await hostedFileContent(h, readme.path, at);
}

export async function hostedTree(h: HostedRepo, ref: string, recursive: boolean) {
	const entries = await h.git.listFiles(h.ref, ref, { recursive });
	return {
		sha: ref,
		url: "",
		truncated: false,
		tree: entries.map((e) => ({
			path: e.path,
			mode: e.mode,
			type: e.type,
			size: e.size ?? undefined,
			sha: "",
			url: "",
		})),
	};
}

export async function hostedBranches(h: HostedRepo) {
	const page = await h.git.listBranches(h.ref);
	return page.items.map((b) => ({
		name: b.name,
		commit: { sha: b.sha, url: "" },
		protected: false,
	}));
}

export async function hostedTags(h: HostedRepo) {
	const page = await h.git.listTags(h.ref);
	return page.items.map((t) => ({
		name: t.name,
		commit: { sha: t.sha, url: "" },
		zipball_url: "",
		tarball_url: "",
		node_id: t.sha,
	}));
}

/** Directory listing; a file path returns the single entry GitHub would. */
export async function hostedContents(h: HostedRepo, path: string, ref?: string) {
	const at = ref || h.defaultBranch;
	const entries = await h.git.listFiles(h.ref, at, { path });
	return entries.map((e) => ({
		name: e.path.split("/").pop() ?? e.path,
		path: e.path,
		sha: "",
		size: e.size ?? 0,
		type: e.type === "tree" ? ("dir" as const) : ("file" as const),
		url: "",
		html_url: `/${h.ref.owner}/${h.ref.repo}/tree/${at}/${e.path}`,
		git_url: "",
		download_url: null,
	}));
}

export async function hostedFileContent(h: HostedRepo, path: string, ref?: string) {
	// A directory is not a file: GitHub answers 404, and the backends reject
	// the empty path outright.
	if (!path) return null;

	const at = ref || h.defaultBranch;
	const blob = await h.git.getFileContent(h.ref, path, at);
	if (!blob) return null;
	return {
		name: path.split("/").pop() ?? path,
		path,
		sha: "",
		size: blob.size,
		type: "file" as const,
		encoding: "utf-8",
		// Decoded even when binary, so the control bytes the viewer sniffs for
		// survive and it shows a download instead of an empty file.
		content: new TextDecoder().decode(blob.content),
		url: "",
		html_url: `/${h.ref.owner}/${h.ref.repo}/blob/${at}/${path}`,
		git_url: "",
		download_url: null,
	};
}

/**
 * Page-numbered like the GitHub call it replaces; the backend is cursored, so
 * earlier pages are walked and discarded.
 */
export async function hostedCommits(
	h: HostedRepo,
	branch: string | undefined,
	page: number,
	perPage: number,
) {
	let cursor: string | undefined;
	let items = [] as Awaited<ReturnType<GitProvider["listCommits"]>>["items"];
	for (let i = 1; i <= page; i++) {
		const result = await h.git.listCommits(h.ref, {
			...(branch ? { branch } : {}),
			limit: perPage,
			...(cursor ? { cursor } : {}),
		});
		items = result.items;
		if (!result.hasMore || !result.nextCursor) {
			if (i < page) return [];
			break;
		}
		cursor = result.nextCursor;
	}
	return items.map((c) => ({
		sha: c.sha,
		node_id: c.sha,
		url: "",
		html_url: `/${h.ref.owner}/${h.ref.repo}/commits/${c.sha}`,
		comments_url: "",
		commit: {
			message: c.message,
			author: { name: c.author.name, email: c.author.email, date: c.date },
			committer: {
				name: c.committer.name,
				email: c.committer.email,
				date: c.date,
			},
			comment_count: 0,
			url: "",
		},
		author: null,
		committer: null,
		parents: c.parents.map((sha) => ({ sha, url: "", html_url: "" })),
	}));
}
