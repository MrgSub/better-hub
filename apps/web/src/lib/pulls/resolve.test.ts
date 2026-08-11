import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequest, Repository } from "@/generated/prisma/client";
import type { GitProvider } from "@/lib/git/provider";
import { GitError } from "@/lib/git/types";
import type { HostedRepo } from "@/lib/repos/hosted-source";

vi.mock("@/lib/db", () => ({
	prisma: {
		pullRequest: { findFirst: vi.fn(), update: vi.fn() },
		pullRequestEvent: { create: vi.fn() },
	},
}));
vi.mock("@/lib/repos/registry", () => ({ repositoryPermission: vi.fn() }));
vi.mock("@/lib/agents/connection", () => ({ repositoryAgent: vi.fn() }));
vi.mock("./conflicts", () => ({ hostedConflicts: vi.fn() }));

import { repositoryAgent } from "@/lib/agents/connection";
import { prisma } from "@/lib/db";
import { repositoryPermission } from "@/lib/repos/registry";
import { hostedConflicts } from "./conflicts";
import { type ConflictAgent, resolveHostedConflicts } from "./resolve";

const actor = { userId: "user_1", login: "adam", name: "Adam", avatarUrl: null };

const pull = {
	id: "pr_1",
	number: 7,
	repositoryId: "repo_1",
	title: "Add a thing",
	bodyMd: "",
	state: "open",
	headBranch: "feature",
	baseBranch: "main",
	headSha: "sha_feature",
} as PullRequest;

function hosted(previewAfter: "clean" | "conflicted") {
	const git = {
		commitFiles: vi.fn().mockResolvedValue({ sha: "sha_resolved" }),
		createBranch: vi.fn().mockResolvedValue({ name: "bh/resolve", sha: "sha_main" }),
		deleteBranch: vi.fn().mockResolvedValue(undefined),
		compare: vi.fn().mockResolvedValue({
			baseSha: "sha_main",
			headSha: "sha_feature",
			mergeBaseSha: "sha_base",
			files: [
				{
					path: "src/a.ts",
					status: "M",
					patch: null,
					truncated: false,
					bytes: null,
				},
				{
					path: "src/b.ts",
					status: "M",
					patch: null,
					truncated: false,
					bytes: null,
				},
			],
			stats: { files: 2, additions: 2, deletions: 0 },
		}),
		getFileContent: vi.fn().mockResolvedValue({
			path: "src/b.ts",
			ref: "feature",
			content: new TextEncoder().encode("head only\n"),
			size: 10,
			binary: false,
		}),
		previewMerge: vi.fn().mockResolvedValue({
			status: previewAfter,
			mergeBaseSha: "sha_base",
			baseSha: "sha_main",
			headSha: "sha_resolved",
			conflicts:
				previewAfter === "clean"
					? []
					: [{ path: "src/a.ts", content: null }],
		}),
	};
	const repo: HostedRepo = {
		ref: { owner: "adam", repo: "hello" },
		defaultBranch: "main",
		record: { id: "repo_1" } as Repository,
		git: git as unknown as GitProvider,
	};
	return { repo, git };
}

function agent(files: { path: string; content: string }[]): ConflictAgent {
	return { name: "test-agent", resolve: vi.fn().mockResolvedValue(files) };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(repositoryPermission).mockResolvedValue("write");
	vi.mocked(prisma.pullRequest.findFirst).mockResolvedValue(pull);
	vi.mocked(prisma.pullRequest.update).mockResolvedValue(pull);
	vi.mocked(hostedConflicts).mockResolvedValue({
		mergeBaseSha: "sha_base",
		baseBranch: "main",
		headBranch: "feature",
		baseSha: "sha_main",
		headSha: "sha_feature",
		files: [
			{
				path: "src/a.ts",
				hunks: [
					{
						type: "conflict",
						baseLines: ["a"],
						headLines: ["b"],
						ancestorLines: [],
					},
				],
				hasConflicts: true,
				autoResolved: false,
			},
		],
	});
});

describe("resolveHostedConflicts", () => {
	it("commits the merged tree on a resolution branch cut from the base", async () => {
		const { repo, git } = hosted("clean");

		const result = await resolveHostedConflicts(
			repo,
			actor,
			7,
			agent([{ path: "src/a.ts", content: "a\nb\n" }]),
		);

		expect(result).toMatchObject({
			ok: true,
			sha: "sha_resolved",
			branch: "bh/resolve/7-sha_feature",
			agent: "test-agent",
		});
		// A ref name, not a sha: the base tip is enforced by the commit guard.
		expect(git.createBranch).toHaveBeenCalledWith(
			repo.ref,
			"bh/resolve/7-sha_feature",
			"main",
		);
		// The pull request's own changes come along, or the branch would revert them.
		expect(git.commitFiles).toHaveBeenCalledWith(
			repo.ref,
			expect.objectContaining({
				branch: "bh/resolve/7-sha_feature",
				expectedHeadSha: "sha_main",
				files: [
					{ path: "src/a.ts", content: "a\nb\n" },
					{ path: "src/b.ts", content: "head only\n" },
				],
			}),
		);
		expect(prisma.pullRequest.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					resolutionBranch: "bh/resolve/7-sha_feature",
					resolutionSha: "sha_resolved",
					resolutionBy: "test-agent",
					events: {
						create: expect.objectContaining({
							kind: "conflict_resolved",
						}),
					},
				}),
			}),
		);
	});

	it("deletes the branch and records nothing when it still cannot merge", async () => {
		const { repo, git } = hosted("conflicted");

		const result = await resolveHostedConflicts(
			repo,
			actor,
			7,
			agent([{ path: "src/a.ts", content: "a\nb\n" }]),
		);

		expect(result).toMatchObject({
			ok: false,
			error: expect.stringContaining("src/a.ts"),
		});
		expect(git.deleteBranch).toHaveBeenCalledWith(repo.ref, "bh/resolve/7-sha_feature");
		expect(prisma.pullRequest.update).not.toHaveBeenCalled();
	});

	it("leaves no branch behind when the backend refuses the commit", async () => {
		const { repo, git } = hosted("clean");
		git.commitFiles.mockRejectedValue(new Error("expected head sha mismatch"));

		const result = await resolveHostedConflicts(
			repo,
			actor,
			7,
			agent([{ path: "src/a.ts", content: "a\nb\n" }]),
		);

		expect(result).toEqual({ ok: false, error: "expected head sha mismatch" });
		expect(git.deleteBranch).toHaveBeenCalledWith(repo.ref, "bh/resolve/7-sha_feature");
	});

	it("explains a base that moved instead of forwarding the backend's ref comparison", async () => {
		const { repo, git } = hosted("clean");
		git.commitFiles.mockRejectedValue(
			new GitError(
				"conflict",
				'{"commit":null,"result":{"status":"conflict","message":"base_ref (sha_main) does not match current head (sha_other)"}}',
				409,
			),
		);

		const result = await resolveHostedConflicts(
			repo,
			actor,
			7,
			agent([{ path: "src/a.ts", content: "a\nb\n" }]),
		);

		expect(result).toEqual({
			ok: false,
			error: "The base branch moved — reload the conflicts and resolve again.",
		});
		expect(git.deleteBranch).toHaveBeenCalledWith(repo.ref, "bh/resolve/7-sha_feature");
		expect(prisma.pullRequest.update).not.toHaveBeenCalled();
	});

	it("never commits output that skipped a file, invented one, or kept a marker", async () => {
		const { repo, git } = hosted("clean");

		for (const [files, expected] of [
			[[], "unresolved"],
			[
				[
					{ path: "src/a.ts", content: "ok" },
					{ path: "src/z.ts", content: "nope" },
				],
				"not in conflict",
			],
			[[{ path: "src/a.ts", content: "<<<<<<< main\na\n" }], "conflict markers"],
		] as const) {
			const result = await resolveHostedConflicts(
				repo,
				actor,
				7,
				agent([...files]),
			);
			expect(result).toMatchObject({
				ok: false,
				error: expect.stringContaining(expected),
			});
		}
		expect(git.commitFiles).not.toHaveBeenCalled();
	});

	it("refuses a viewer who cannot write", async () => {
		const { repo, git } = hosted("clean");
		vi.mocked(repositoryPermission).mockResolvedValue("read");

		const result = await resolveHostedConflicts(repo, actor, 7, agent([]));

		expect(result).toMatchObject({
			ok: false,
			error: expect.stringContaining("write access"),
		});
		expect(git.commitFiles).not.toHaveBeenCalled();
	});

	it("resolves nothing for a namespace that has connected no agent", async () => {
		const { repo, git } = hosted("clean");
		vi.mocked(repositoryAgent).mockResolvedValue(null);

		const result = await resolveHostedConflicts(repo, actor, 7);

		expect(result).toMatchObject({
			ok: false,
			error: expect.stringContaining("Automatic conflict resolution is off"),
		});
		expect(git.commitFiles).not.toHaveBeenCalled();
	});

	it("uses the agent the namespace connected when none is passed in", async () => {
		const { repo, git } = hosted("clean");
		vi.mocked(repositoryAgent).mockResolvedValue({
			provider: "model",
			apiKey: null,
			accountId: null,
		});

		const result = await resolveHostedConflicts(repo, actor, 7);

		// The model agent itself is unreachable in a unit test; what matters is
		// that the connection was consulted and the run was not refused.
		expect(repositoryAgent).toHaveBeenCalledWith(repo.record);
		expect(result).toMatchObject({ ok: false });
		expect(git.commitFiles).not.toHaveBeenCalled();
	});

	it("reports an agent failure instead of throwing", async () => {
		const { repo } = hosted("clean");
		const failing: ConflictAgent = {
			name: "test-agent",
			resolve: vi.fn().mockRejectedValue(new Error("model unavailable")),
		};

		expect(await resolveHostedConflicts(repo, actor, 7, failing)).toEqual({
			ok: false,
			error: "model unavailable",
		});
	});
});
