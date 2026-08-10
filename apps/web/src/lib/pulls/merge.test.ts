import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequest, Repository } from "@/generated/prisma/client";
import type { GitProvider } from "@/lib/git/provider";
import type { MergeResult } from "@/lib/git/types";
import type { HostedRepo } from "@/lib/repos/hosted-source";

vi.mock("@/lib/db", () => ({
	prisma: {
		$transaction: vi.fn(async (run: (tx: unknown) => unknown) =>
			run({ $executeRaw: vi.fn() }),
		),
		pullRequest: {
			findFirst: vi.fn(),
			findMany: vi.fn(),
			update: vi.fn(),
			count: vi.fn(),
		},
		pullRequestEvent: { create: vi.fn() },
	},
}));
vi.mock("@/lib/repos/registry", () => ({ repositoryPermission: vi.fn() }));

import { prisma } from "@/lib/db";
import { repositoryPermission } from "@/lib/repos/registry";
import { mergeHostedPull } from "./merge";

const actor = { userId: "user_1", login: "adam", name: "Adam", avatarUrl: null };

function pull(over: Partial<PullRequest> = {}): PullRequest {
	return {
		id: "pr_1",
		number: 7,
		repositoryId: "repo_1",
		title: "Add a thing",
		bodyMd: "",
		state: "open",
		draft: false,
		headBranch: "feature",
		baseBranch: "main",
		headSha: "sha_feature",
		baseSha: "sha_main",
		mergeSha: null,
		parentId: null,
		...over,
	} as PullRequest;
}

interface GitStub {
	branches: Record<string, string>;
	preview?: { status: "clean" | "conflicted"; conflicts?: { path: string }[] };
	merge?: MergeResult;
}

function hosted(stub: GitStub) {
	const git = {
		listBranches: vi.fn().mockResolvedValue({
			items: Object.entries(stub.branches).map(([name, sha]) => ({
				name,
				sha,
				createdAt: null,
			})),
			nextCursor: null,
			hasMore: false,
		}),
		previewMerge: vi.fn().mockResolvedValue({
			status: stub.preview?.status ?? "clean",
			mergeBaseSha: "sha_base",
			baseSha: stub.branches.main,
			headSha: stub.branches.feature,
			conflicts: stub.preview?.conflicts ?? [],
		}),
		merge: vi.fn().mockResolvedValue(
			stub.merge ?? {
				merged: true,
				sha: "sha_merged",
				status: "clean",
				conflicts: [],
			},
		),
		deleteBranch: vi.fn().mockResolvedValue(undefined),
	};
	const repo: HostedRepo = {
		ref: { owner: "adam", repo: "hello" },
		defaultBranch: "main",
		record: { id: "repo_1" } as Repository,
		git: git as unknown as GitProvider,
	};
	return { repo, git };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(repositoryPermission).mockResolvedValue("write");
	vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(pull());
	vi.mocked(prisma.pullRequest.findMany).mockResolvedValue([]);
	vi.mocked(prisma.pullRequest.count).mockResolvedValue(0);
	vi.mocked(prisma.pullRequest.update).mockImplementation(
		// biome-ignore lint/suspicious/noExplicitAny: prisma's update arg is generic
		(async ({ data }: any) => ({ ...pull(), ...data })) as never,
	);
});

describe("mergeHostedPull", () => {
	it("merges through the provider with the base sha it verified", async () => {
		const { repo, git } = hosted({
			branches: { main: "sha_main", feature: "sha_feature" },
		});

		const result = await mergeHostedPull(repo, actor, {
			number: 7,
			strategy: "squash",
		});

		expect(result).toMatchObject({ ok: true, sha: "sha_merged" });
		expect(git.merge).toHaveBeenCalledWith(
			repo.ref,
			"main",
			"feature",
			expect.objectContaining({
				strategy: "squash",
				expectedBaseSha: "sha_main",
			}),
		);
	});

	it("refuses when the head branch moved since the diff was loaded", async () => {
		const { repo, git } = hosted({
			branches: { main: "sha_main", feature: "sha_newer" },
		});

		const result = await mergeHostedPull(repo, actor, { number: 7 });

		expect(result).toMatchObject({
			ok: false,
			error: expect.stringContaining("new commits"),
		});
		expect(git.merge).not.toHaveBeenCalled();
		expect(prisma.pullRequest.update).toHaveBeenCalledWith(
			expect.objectContaining({ data: { headSha: "sha_newer" } }),
		);
	});

	it("does not ask the provider to merge a conflicted preview", async () => {
		const { repo, git } = hosted({
			branches: { main: "sha_main", feature: "sha_feature" },
			preview: { status: "conflicted", conflicts: [{ path: "src/a.ts" }] },
		});

		const result = await mergeHostedPull(repo, actor, { number: 7 });

		expect(result).toMatchObject({
			ok: false,
			conflicts: [{ path: "src/a.ts" }],
		});
		expect(git.merge).not.toHaveBeenCalled();
		expect(prisma.pullRequestEvent.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ kind: "conflicted" }),
			}),
		);
	});

	it("leaves the pull request open when the provider itself reports a conflict", async () => {
		const { repo } = hosted({
			branches: { main: "sha_main", feature: "sha_feature" },
			merge: {
				merged: false,
				sha: null,
				status: "conflicted",
				conflicts: [{ path: "src/b.ts", content: null }],
			},
		});

		const result = await mergeHostedPull(repo, actor, { number: 7 });

		expect(result).toMatchObject({ ok: false });
		expect(prisma.pullRequest.update).not.toHaveBeenCalled();
	});

	it("refuses a viewer who cannot write, and a draft", async () => {
		const { repo, git } = hosted({
			branches: { main: "sha_main", feature: "sha_feature" },
		});
		vi.mocked(repositoryPermission).mockResolvedValue("read");
		expect(await mergeHostedPull(repo, actor, { number: 7 })).toMatchObject({
			ok: false,
			error: expect.stringContaining("write access"),
		});

		vi.mocked(repositoryPermission).mockResolvedValue("write");
		vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(pull({ draft: true }));
		expect(await mergeHostedPull(repo, actor, { number: 7 })).toMatchObject({
			ok: false,
			error: expect.stringContaining("draft"),
		});
		expect(git.merge).not.toHaveBeenCalled();
	});

	it("keeps a merged branch that another pull request is stacked on", async () => {
		const { repo, git } = hosted({
			branches: { main: "sha_main", feature: "sha_feature" },
		});
		vi.mocked(prisma.pullRequest.count).mockResolvedValue(1);

		await mergeHostedPull(repo, actor, { number: 7, deleteBranch: true });

		expect(git.deleteBranch).not.toHaveBeenCalled();
	});

	it("deletes the branch when nothing stacks on it", async () => {
		const { repo, git } = hosted({
			branches: { main: "sha_main", feature: "sha_feature" },
		});

		await mergeHostedPull(repo, actor, { number: 7, deleteBranch: true });

		expect(git.deleteBranch).toHaveBeenCalledWith(repo.ref, "feature");
	});
});

describe("restacking a stack", () => {
	const child = pull({
		id: "pr_2",
		number: 8,
		headBranch: "feature-2",
		baseBranch: "feature",
		parentId: "pr_1",
	});
	const grandchild = pull({
		id: "pr_3",
		number: 9,
		headBranch: "feature-3",
		baseBranch: "feature-2",
		parentId: "pr_2",
	});

	it("moves a direct child onto the merged base and carries commits further up", async () => {
		const { repo, git } = hosted({
			branches: { main: "sha_main", feature: "sha_feature" },
		});
		vi.mocked(prisma.pullRequest.findMany)
			.mockResolvedValueOnce([child])
			.mockResolvedValueOnce([grandchild])
			.mockResolvedValue([]);

		const result = await mergeHostedPull(repo, actor, { number: 7 });

		expect(result).toMatchObject({
			ok: true,
			restacked: [
				{ number: 8, status: "restacked" },
				{ number: 9, status: "restacked" },
			],
		});
		// The child re-targets `main`; the grandchild keeps its own base, which
		// still exists, and only takes the child's new commits.
		expect(git.merge).toHaveBeenNthCalledWith(
			2,
			repo.ref,
			"feature-2",
			"main",
			expect.anything(),
		);
		expect(git.merge).toHaveBeenNthCalledWith(
			3,
			repo.ref,
			"feature-3",
			"feature-2",
			expect.anything(),
		);
	});

	it("stops a limb at its first conflict and leaves what is above it alone", async () => {
		const { repo, git } = hosted({
			branches: { main: "sha_main", feature: "sha_feature" },
		});
		vi.mocked(prisma.pullRequest.findMany)
			.mockResolvedValueOnce([child])
			.mockResolvedValue([grandchild]);
		git.merge
			.mockResolvedValueOnce({
				merged: true,
				sha: "sha_merged",
				status: "clean",
				conflicts: [],
			})
			.mockResolvedValueOnce({
				merged: false,
				sha: null,
				status: "conflicted",
				conflicts: [{ path: "src/c.ts", content: null }],
			});

		const result = await mergeHostedPull(repo, actor, { number: 7 });

		expect(result).toMatchObject({
			ok: true,
			restacked: [{ number: 8, status: "conflicted" }],
		});
		expect(git.merge).toHaveBeenCalledTimes(2);
		expect(prisma.pullRequest.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					baseBranch: "main",
					events: {
						create: expect.objectContaining({
							kind: "restack_conflicted",
						}),
					},
				}),
			}),
		);
	});
});
