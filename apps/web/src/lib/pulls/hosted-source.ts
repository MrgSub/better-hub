import type { PullRequest, PullRequestComment } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import type { CompareResult, FileDiff } from "@/lib/git/types";
import type { PRBundleData, PRPageResult, ReviewThread } from "@/lib/github";
import type { HostedRepo } from "@/lib/repos/hosted-source";

/**
 * Pull requests we own, read back in the GitHub shapes `lib/github.ts` returns.
 *
 * Issues stay upstream, so only this half moves: the rows live in Postgres and
 * the diff comes from the git backend, which is what lets a review happen while
 * GitHub is down. Payloads mirror the REST/GraphQL fields the pull request
 * pages already read, so nothing above this layer changes.
 */

type ListedPull = PRPageResult["prs"][number];

/** GitHub spells out what git abbreviates to a letter. */
const FILE_STATUS: Record<FileDiff["status"], string> = {
	A: "added",
	M: "modified",
	D: "removed",
	R: "renamed",
	C: "copied",
	T: "changed",
};

/** "open" and "merged" are ours; the pages only know GitHub's two states. */
function githubState(state: string): "open" | "closed" {
	return state === "open" ? "open" : "closed";
}

function actor(login: string | null, avatarUrl: string | null) {
	if (!login) return null;
	return { login, avatar_url: avatarUrl ?? "" };
}

/**
 * The backends report a diff as a patch without per-file totals, and the pages
 * render those totals, so they are counted here rather than stored per file.
 */
function patchStats(patch: string | null): { additions: number; deletions: number } {
	if (!patch) return { additions: 0, deletions: 0 };
	let additions = 0;
	let deletions = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions++;
		else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
	}
	return { additions, deletions };
}

/** Comment counts for a page of pull requests, in two queries instead of 2n. */
async function commentCounts(
	pullRequestIds: string[],
): Promise<Map<string, { comments: number; reviewComments: number }>> {
	const counts = new Map<string, { comments: number; reviewComments: number }>();
	if (pullRequestIds.length === 0) return counts;

	const grouped = await prisma.pullRequestComment.groupBy({
		by: ["pullRequestId", "path"],
		where: { pullRequestId: { in: pullRequestIds } },
		_count: { _all: true },
	});
	for (const row of grouped) {
		const entry = counts.get(row.pullRequestId) ?? { comments: 0, reviewComments: 0 };
		// An anchored comment is a review comment; everything else is conversation.
		if (row.path === null) entry.comments += row._count._all;
		else entry.reviewComments += row._count._all;
		counts.set(row.pullRequestId, entry);
	}
	return counts;
}

function toListedPull(
	row: PullRequest,
	owner: string,
	counts: { comments: number; reviewComments: number } | undefined,
): ListedPull {
	return {
		id: row.number,
		number: row.number,
		title: row.title,
		state: githubState(row.state),
		draft: row.draft,
		updated_at: row.updatedAt.toISOString(),
		created_at: row.createdAt.toISOString(),
		comments: counts?.comments ?? 0,
		review_comments: counts?.reviewComments ?? 0,
		user: actor(row.authorLogin, row.authorAvatarUrl),
		labels: [],
		// GitHub's mapper infers this as `string` although it answers null for
		// an unmerged pull request, which is what the pages check for.
		merged_at: (row.mergedAt?.toISOString() ?? null) as string,
		head: { ref: row.headBranch, sha: row.headSha },
		head_repo_owner: owner,
		head_repo_name: null,
		base: { ref: row.baseBranch },
		requested_reviewers: [],
		assignees: [],
		additions: row.additions,
		deletions: row.deletions,
		changed_files: row.changedFiles,
	};
}

const STATE_FILTER: Record<"open" | "closed" | "all", string[] | undefined> = {
	open: ["open"],
	closed: ["closed", "merged"],
	all: undefined,
};

/**
 * One page of pull requests, cursored by row id so a new pull request opening
 * mid-scroll cannot shift the page under the reader the way an offset would.
 */
export async function hostedPullPage(
	h: HostedRepo,
	state: "open" | "closed" | "all",
	opts?: {
		includeCounts?: boolean;
		previewClosed?: number;
		perPage?: number;
		cursor?: string | null;
	},
): Promise<PRPageResult> {
	const limit = opts?.perPage ?? 20;
	const repositoryId = h.record.id;
	const states = STATE_FILTER[state];

	const rows = await prisma.pullRequest.findMany({
		where: { repositoryId, ...(states ? { state: { in: states } } : {}) },
		orderBy: { createdAt: "desc" },
		take: limit + 1,
		...(opts?.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
	});
	const hasNextPage = rows.length > limit;
	const page = hasNextPage ? rows.slice(0, limit) : rows;

	const previewCount = opts?.previewClosed ?? 0;
	const [merged, closed] =
		previewCount > 0
			? await Promise.all(
					(["merged", "closed"] as const).map((s) =>
						prisma.pullRequest.findMany({
							where: { repositoryId, state: s },
							orderBy: { updatedAt: "desc" },
							take: previewCount,
						}),
					),
				)
			: [[], []];

	const counts = await commentCounts([...page, ...merged, ...closed].map((row) => row.id));
	const map = (row: PullRequest) => toListedPull(row, h.ref.owner, counts.get(row.id));

	return {
		prs: page.map(map),
		pageInfo: {
			hasNextPage,
			endCursor: hasNextPage ? (page.at(-1)?.id ?? null) : null,
		},
		counts: opts?.includeCounts
			? await hostedPullCounts(repositoryId)
			: { open: 0, merged: 0, closed: 0 },
		mergedPreview: merged.map(map),
		closedPreview: closed.map(map),
	};
}

export async function hostedPullCounts(
	repositoryId: string,
): Promise<{ open: number; merged: number; closed: number }> {
	const grouped = await prisma.pullRequest.groupBy({
		by: ["state"],
		where: { repositoryId },
		_count: { _all: true },
	});
	const of = (state: string) => grouped.find((row) => row.state === state)?._count._all ?? 0;
	return { open: of("open"), merged: of("merged"), closed: of("closed") };
}

export async function hostedOpenPullCount(repositoryId: string): Promise<number> {
	return await prisma.pullRequest.count({ where: { repositoryId, state: "open" } });
}

function findPull(h: HostedRepo, number: number) {
	return prisma.pullRequest.findUnique({
		where: { repositoryId_number: { repositoryId: h.record.id, number } },
	});
}

/**
 * The diff, read live from the branches rather than from the SHAs the row was
 * opened at, so a push shows up without a webhook. Null when either branch is
 * gone, which the callers already treat as "no files".
 */
async function pullCompare(h: HostedRepo, row: PullRequest): Promise<CompareResult | null> {
	try {
		return await h.git.compare(h.ref, row.baseBranch, row.headBranch);
	} catch {
		return null;
	}
}

/** Shaped like `pulls.get`, which is a superset of what the pages read. */
export async function hostedPull(h: HostedRepo, number: number) {
	const row = await findPull(h, number);
	if (!row) return null;

	const [diff, mergeable] = await Promise.all([
		pullCompare(h, row),
		row.state === "open" ? hostedMergeable(h, row) : null,
	]);

	return {
		id: row.number,
		number: row.number,
		title: row.title,
		body: row.bodyMd,
		state: githubState(row.state),
		draft: row.draft,
		locked: false,
		merged: row.state === "merged",
		merged_at: row.mergedAt?.toISOString() ?? null,
		merge_commit_sha: row.mergeSha,
		mergeable,
		mergeable_state: mergeable === null ? "unknown" : mergeable ? "clean" : "dirty",
		closed_at: row.closedAt?.toISOString() ?? null,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
		additions: diff?.stats.additions ?? row.additions,
		deletions: diff?.stats.deletions ?? row.deletions,
		changed_files: diff?.stats.files ?? row.changedFiles,
		commits: 0,
		comments: 0,
		review_comments: 0,
		user: actor(row.authorLogin, row.authorAvatarUrl),
		labels: [],
		assignees: [],
		requested_reviewers: [],
		head: {
			ref: row.headBranch,
			sha: diff?.headSha ?? row.headSha,
			repo: { name: h.ref.repo, owner: { login: h.ref.owner } },
		},
		base: {
			ref: row.baseBranch,
			sha: diff?.baseSha ?? row.baseSha,
			repo: { name: h.ref.repo, owner: { login: h.ref.owner } },
		},
		html_url: `/${h.ref.owner}/${h.ref.repo}/pull/${row.number}`,
	};
}

/** Null rather than false when the backend could not say. */
async function hostedMergeable(h: HostedRepo, row: PullRequest): Promise<boolean | null> {
	try {
		const preview = await h.git.previewMerge(h.ref, row.baseBranch, row.headBranch);
		return preview.status !== "conflicted";
	} catch {
		return null;
	}
}

function toChangedFiles(diff: CompareResult) {
	return diff.files.map((file) => {
		const stats = patchStats(file.patch);
		return {
			filename: file.path,
			status: FILE_STATUS[file.status],
			additions: stats.additions,
			deletions: stats.deletions,
			changes: stats.additions + stats.deletions,
			patch: file.patch ?? undefined,
			sha: diff.headSha,
			blob_url: "",
			raw_url: "",
			contents_url: "",
		};
	});
}

export async function hostedPullFiles(h: HostedRepo, number: number) {
	const row = await findPull(h, number);
	if (!row) return [];
	const diff = await pullCompare(h, row);
	return diff ? toChangedFiles(diff) : [];
}

/**
 * Two branches compared for the "open a pull request" screen, before any row
 * exists — same fields as `repos.compareCommits` returns.
 */
export async function hostedCompare(h: HostedRepo, base: string, head: string) {
	const diff = await h.git.compare(h.ref, base, head);
	const [ahead, behind] = await Promise.all([
		commitsAhead(h, head, diff.mergeBaseSha),
		commitsAhead(h, base, diff.mergeBaseSha),
	]);
	return {
		ahead_by: ahead.length,
		behind_by: behind.length,
		total_commits: ahead.length,
		files: toChangedFiles(diff),
		commits: ahead.map((commit) => ({
			sha: commit.sha,
			message: commit.message,
			author: { login: commit.author.name, avatar_url: "" },
			date: commit.date,
		})),
	};
}

/**
 * Commits a branch carries beyond `stopAt` — walked from the tip because the
 * backends list commits per branch, not per range.
 */
async function commitsAhead(h: HostedRepo, branch: string, stopAt: string | null) {
	const page = await h.git.listCommits(h.ref, { branch, limit: 100 });
	const own = [];
	for (const commit of page.items) {
		if (commit.sha === stopAt) break;
		own.push(commit);
	}
	return own;
}

export async function hostedPullCommits(h: HostedRepo, number: number) {
	const row = await findPull(h, number);
	if (!row) return [];
	const diff = await pullCompare(h, row);
	const own = await commitsAhead(h, row.headBranch, diff?.mergeBaseSha ?? row.baseSha);

	return own.map((commit) => ({
		sha: commit.sha,
		commit: {
			message: commit.message,
			author: {
				name: commit.author.name,
				email: commit.author.email,
				date: commit.date,
			},
			committer: {
				name: commit.committer.name,
				email: commit.committer.email,
				date: commit.date,
			},
		},
		author: null,
		committer: null,
		parents: commit.parents.map((sha) => ({ sha })),
	}));
}

/**
 * Comment ids are cuids while GitHub's are numbers the pages pass around, so a
 * stable numeric alias is derived from the cuid; the string id stays available
 * for the mutations that address a row.
 */
function numericId(id: string): number {
	let hash = 0;
	for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 2_147_483_647;
	return hash;
}

export async function hostedPullComments(h: HostedRepo, number: number) {
	const row = await findPull(h, number);
	if (!row) return { issueComments: [], reviewComments: [] };
	const rows = await prisma.pullRequestComment.findMany({
		where: { pullRequestId: row.id },
		orderBy: { createdAt: "asc" },
	});
	return {
		issueComments: rows.filter((c) => c.path === null).map(toIssueComment),
		reviewComments: rows.filter((c) => c.path !== null).map(toReviewComment),
	};
}

function toIssueComment(c: PullRequestComment) {
	return {
		id: numericId(c.id),
		node_id: c.id,
		body: c.bodyMd,
		created_at: c.createdAt.toISOString(),
		updated_at: c.updatedAt.toISOString(),
		user: actor(c.authorLogin, c.authorAvatarUrl),
		author_association: "NONE",
		reactions: undefined,
	};
}

function toReviewComment(c: PullRequestComment) {
	return {
		id: numericId(c.id),
		node_id: c.id,
		body: c.bodyMd,
		path: c.path ?? "",
		line: c.line,
		side: c.side ?? "RIGHT",
		diff_hunk: c.diffHunk,
		created_at: c.createdAt.toISOString(),
		updated_at: c.updatedAt.toISOString(),
		user: actor(c.authorLogin, c.authorAvatarUrl),
		pull_request_review_id: 0,
		reactions: undefined,
	};
}

export async function hostedPullReviews(h: HostedRepo, number: number) {
	const row = await findPull(h, number);
	if (!row) return [];
	const rows = await prisma.pullRequestReview.findMany({
		where: { pullRequestId: row.id },
		orderBy: { createdAt: "asc" },
	});
	return rows.map((review) => ({
		id: numericId(review.id),
		node_id: review.id,
		body: review.bodyMd,
		state: review.state.toUpperCase(),
		commit_id: review.commitSha,
		created_at: review.createdAt.toISOString(),
		submitted_at: review.createdAt.toISOString(),
		user: actor(review.reviewerLogin, review.reviewerAvatarUrl),
	}));
}

/**
 * Threads are derived rather than stored: a root comment plus its replies is a
 * thread, which keeps one comment table for both kinds.
 */
export async function hostedPullReviewThreads(
	h: HostedRepo,
	number: number,
): Promise<ReviewThread[]> {
	const row = await findPull(h, number);
	if (!row) return [];
	const rows = await prisma.pullRequestComment.findMany({
		where: { pullRequestId: row.id, path: { not: null } },
		orderBy: { createdAt: "asc" },
	});

	const roots = rows.filter((c) => c.inReplyToId === null);
	return roots.map((root) => {
		const comments = [root, ...rows.filter((c) => c.inReplyToId === root.id)];
		return {
			id: root.id,
			isResolved: root.resolvedAt !== null,
			isOutdated: false,
			path: root.path ?? "",
			line: root.line,
			startLine: null,
			diffSide: root.side ?? "RIGHT",
			resolvedBy: root.resolvedById ? { login: root.resolvedById } : null,
			comments: comments.map((c) => ({
				id: c.id,
				databaseId: numericId(c.id),
				body: c.bodyMd,
				createdAt: c.createdAt.toISOString(),
				author: c.authorLogin
					? {
							login: c.authorLogin,
							avatarUrl: c.authorAvatarUrl ?? "",
						}
					: null,
				reviewState: null,
			})),
		};
	});
}

const TIMELINE_EVENTS: Record<string, PRBundleData["stateEvents"][number]["event"]> = {
	closed: "closed",
	reopened: "reopened",
	merged: "merged",
	ready_for_review: "ready_for_review",
	convert_to_draft: "convert_to_draft",
};

/** Everything the detail page reads, in the one bundle it asks for. */
export async function hostedPullBundle(
	h: HostedRepo,
	number: number,
): Promise<PRBundleData | null> {
	const row = await findPull(h, number);
	if (!row) return null;

	const [pr, comments, reviews, reviewThreads, commits, events] = await Promise.all([
		hostedPull(h, number),
		hostedPullComments(h, number),
		hostedPullReviews(h, number),
		hostedPullReviewThreads(h, number),
		hostedPullCommits(h, number),
		prisma.pullRequestEvent.findMany({
			where: {
				pullRequestId: row.id,
				kind: { in: Object.keys(TIMELINE_EVENTS) },
			},
			orderBy: { createdAt: "asc" },
		}),
	]);
	if (!pr) return null;

	return {
		pr: {
			number: pr.number,
			title: pr.title,
			body: pr.body,
			state: pr.state,
			draft: pr.draft,
			created_at: pr.created_at,
			merged_at: pr.merged_at,
			mergeable: pr.mergeable,
			additions: pr.additions,
			deletions: pr.deletions,
			changed_files: pr.changed_files,
			user: pr.user ?? null,
			head: { ref: pr.head.ref, sha: pr.head.sha },
			head_repo_owner: h.ref.owner,
			head_repo_name: h.ref.repo,
			base: { ref: pr.base.ref, sha: pr.base.sha },
			labels: [],
			reactions: undefined,
		},
		issueComments: comments.issueComments,
		reviewComments: comments.reviewComments.map((c) => ({
			...c,
			line: c.line,
			diff_hunk: c.diff_hunk,
		})),
		reviews,
		reviewThreads,
		commits: commits.map((c) => ({
			sha: c.sha,
			commit: {
				message: c.commit.message,
				author: { name: c.commit.author.name, date: c.commit.author.date },
				committer: {
					name: c.commit.committer.name,
					date: c.commit.committer.date,
				},
			},
			author: null,
		})),
		stateEvents: events.map((event) => ({
			id: event.id,
			event: TIMELINE_EVENTS[
				event.kind
			] as PRBundleData["stateEvents"][number]["event"],
			actor: event.actorLogin
				? { login: event.actorLogin, avatar_url: "" }
				: null,
			created_at: event.createdAt.toISOString(),
			...(event.kind === "merged" && row.mergeSha
				? { merge_ref_name: row.baseBranch }
				: {}),
		})),
	};
}
