import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequest, Repository } from "@/generated/prisma/client";
import type { GitProvider } from "@/lib/git/provider";
import type { HostedRepo } from "@/lib/repos/hosted-source";

vi.mock("@/lib/db", () => ({
	prisma: {
		pullRequest: {
			findMany: vi.fn().mockResolvedValue([]),
			findUnique: vi.fn().mockResolvedValue(null),
			groupBy: vi.fn().mockResolvedValue([]),
			count: vi.fn().mockResolvedValue(0),
		},
		pullRequestComment: {
			findMany: vi.fn().mockResolvedValue([]),
			groupBy: vi.fn().mockResolvedValue([]),
		},
		pullRequestReview: { findMany: vi.fn().mockResolvedValue([]) },
		pullRequestEvent: { findMany: vi.fn().mockResolvedValue([]) },
	},
}));

import { prisma } from "@/lib/db";
import { hostedCompare, hostedPull, hostedPullFiles, hostedPullPage } from "./hosted-source";

function row(overrides: Partial<PullRequest> = {}): PullRequest {
	return {
		id: "pr_1",
		repositoryId: "repo_1",
		number: 7,
		title: "Add a thing",
		bodyMd: "why",
		state: "open",
		draft: false,
		headBranch: "feature",
		baseBranch: "main",
		headSha: "sha_feature",
		baseSha: "sha_main",
		mergeSha: null,
		additions: 5,
		deletions: 1,
		changedFiles: 2,
		parentId: null,
		stackId: null,
		authorId: "user_1",
		authorLogin: "adam",
		authorName: "Adam",
		authorAvatarUrl: "https://example.com/adam.png",
		mergedById: null,
		mergedAt: null,
		closedAt: null,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-02T00:00:00.000Z"),
		...overrides,
	} as PullRequest;
}

const DIFF = {
	baseSha: "sha_main",
	headSha: "sha_feature",
	mergeBaseSha: "sha_main",
	files: [
		{
			path: "a.ts",
			status: "M" as const,
			patch: "@@ -1 +1,2 @@\n-old\n+new\n+another",
			truncated: false,
			bytes: null,
		},
	],
	stats: { files: 1, additions: 2, deletions: 1 },
};

function hosted(git: Partial<GitProvider> = {}): HostedRepo {
	return {
		ref: { owner: "adam", repo: "hello" },
		defaultBranch: "main",
		record: { id: "repo_1" } as Repository,
		git: {
			compare: vi.fn().mockResolvedValue(DIFF),
			previewMerge: vi.fn().mockResolvedValue({
				status: "clean",
				mergeBaseSha: "sha_main",
				baseSha: "sha_main",
				headSha: "sha_feature",
				conflicts: [],
			}),
			listCommits: vi.fn().mockResolvedValue({
				items: [],
				nextCursor: null,
				hasMore: false,
			}),
			...git,
		} as unknown as GitProvider,
	};
}

beforeEach(() => {
	vi.mocked(prisma.pullRequest.findUnique).mockResolvedValue(row() as never);
	vi.mocked(prisma.pullRequestComment.groupBy).mockResolvedValue([] as never);
});

describe("hostedPullPage", () => {
	it("maps our rows onto the shape the list renders, merged rows included", async () => {
		vi.mocked(prisma.pullRequest.findMany).mockResolvedValueOnce([
			row(),
			row({
				id: "pr_2",
				number: 6,
				state: "merged",
				mergedAt: new Date("2026-01-03T00:00:00.000Z"),
			}),
		] as never);
		vi.mocked(prisma.pullRequestComment.groupBy).mockResolvedValueOnce([
			{ pullRequestId: "pr_1", path: null, _count: { _all: 2 } },
			{ pullRequestId: "pr_1", path: "a.ts", _count: { _all: 3 } },
		] as never);

		const page = await hostedPullPage(hosted(), "all");

		expect(page.prs[0]).toMatchObject({
			number: 7,
			state: "open",
			merged_at: null,
			comments: 2,
			review_comments: 3,
			user: { login: "adam", avatar_url: "https://example.com/adam.png" },
			head: { ref: "feature", sha: "sha_feature" },
			base: { ref: "main" },
		});
		// The pages only know GitHub's two states, so merged reads as closed
		// while `merged_at` is what distinguishes it.
		expect(page.prs[1]).toMatchObject({
			state: "closed",
			merged_at: "2026-01-03T00:00:00.000Z",
		});
	});

	it("cursors on the last row rather than an offset", async () => {
		vi.mocked(prisma.pullRequest.findMany).mockResolvedValueOnce([
			row(),
			row({ id: "pr_2", number: 6 }),
		] as never);

		const page = await hostedPullPage(hosted(), "open", { perPage: 1 });

		expect(page.prs).toHaveLength(1);
		expect(page.pageInfo).toEqual({ hasNextPage: true, endCursor: "pr_1" });
	});

	it("asks only for open rows when the tab is open", async () => {
		await hostedPullPage(hosted(), "open");

		expect(prisma.pullRequest.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { repositoryId: "repo_1", state: { in: ["open"] } },
			}),
		);
	});
});

describe("hostedPull", () => {
	it("reports the live diff and merge status, not the stored one", async () => {
		const pull = await hostedPull(hosted(), 7);

		expect(pull).toMatchObject({
			number: 7,
			state: "open",
			mergeable: true,
			additions: 2,
			deletions: 1,
			changed_files: 1,
		});
	});

	it("leaves mergeability unknown when the backend cannot say", async () => {
		const pull = await hostedPull(
			hosted({ previewMerge: vi.fn().mockRejectedValue(new Error("down")) }),
			7,
		);

		expect(pull).toMatchObject({ mergeable: null, mergeable_state: "unknown" });
	});

	it("is null for a number we do not have", async () => {
		vi.mocked(prisma.pullRequest.findUnique).mockResolvedValueOnce(null);
		expect(await hostedPull(hosted(), 99)).toBeNull();
	});
});

describe("hostedPullFiles", () => {
	// The backends hand back a patch without totals, so the viewer's counts
	// come from counting its lines.
	it("counts additions and deletions out of the patch", async () => {
		const files = await hostedPullFiles(hosted(), 7);

		expect(files).toEqual([
			expect.objectContaining({
				filename: "a.ts",
				status: "modified",
				additions: 2,
				deletions: 1,
				changes: 3,
			}),
		]);
	});

	it("is empty when the branches are gone", async () => {
		const files = await hostedPullFiles(
			hosted({ compare: vi.fn().mockRejectedValue(new Error("no such branch")) }),
			7,
		);
		expect(files).toEqual([]);
	});
});

describe("hostedCompare", () => {
	it("counts each side's commits from the merge base", async () => {
		const commit = (sha: string) => ({
			sha,
			message: `commit ${sha}`,
			parents: [],
			author: { name: "Adam", email: "adam@example.com" },
			committer: { name: "Adam", email: "adam@example.com" },
			date: "2026-01-01T00:00:00Z",
		});
		const listCommits = vi.fn().mockImplementation((_ref, o) =>
			Promise.resolve({
				items:
					o.branch === "feature"
						? [commit("c2"), commit("c1"), commit("sha_main")]
						: [commit("sha_main")],
				nextCursor: null,
				hasMore: false,
			}),
		);

		const comparison = await hostedCompare(hosted({ listCommits }), "main", "feature");

		expect(comparison).toMatchObject({ ahead_by: 2, behind_by: 0, total_commits: 2 });
		expect(comparison.commits.map((c) => c.sha)).toEqual(["c2", "c1"]);
	});
});
